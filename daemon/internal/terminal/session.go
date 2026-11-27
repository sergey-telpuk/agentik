package terminal

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type session struct {
	id        string
	projectID string
	owner     Owner
	m         *Manager
	cmd       *exec.Cmd
	ptmx      *os.File
	pid       int

	input     chan []byte
	stop      chan struct{} // closed when termination starts
	exited    chan struct{} // closed when the shell has been reaped
	readDone  chan struct{}
	writeDone chan struct{}
	done      chan struct{} // closed when processes are gone and the PTY is closed
	stopOnce  sync.Once
	idleTimer *time.Timer

	mu        sync.Mutex
	cond      *sync.Cond // the reader waits here for buffer space
	chunks    []Chunk
	buffered  int
	lastSeq   int64 // seq of the newest chunk
	acked     int64 // every chunk up to here was acknowledged and dropped
	delivered int64 // highest seq handed to a reader; such chunks never change
	notify    chan struct{}
	waiter    chan struct{}
	stopping  bool
	ended     bool
	reason    string
	exitCode  *int
	lastSeen  time.Time
}

func (s *session) isEnded() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ended
}

func (s *session) isStopping() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopping
}

func (s *session) touch() {
	s.mu.Lock()
	s.lastSeen = time.Now()
	s.mu.Unlock()
}

// broadcastLocked wakes every waiting Read.
func (s *session) broadcastLocked() {
	close(s.notify)
	s.notify = make(chan struct{})
}

func (s *session) control(fn func(fd int) error) error {
	raw, err := s.ptmx.SyscallConn()
	if err != nil {
		return err
	}
	var inner error
	if err := raw.Control(func(fd uintptr) { inner = fn(int(fd)) }); err != nil {
		return err
	}
	return inner
}

// setSize uses the raw descriptor: os.File.Fd would switch the PTY back to
// blocking mode.
func (s *session) setSize(cols, rows uint16) error {
	return s.control(func(fd int) error {
		return unix.IoctlSetWinsize(fd, unix.TIOCSWINSZ, &unix.Winsize{Col: cols, Row: rows})
	})
}

func (s *session) foregroundGroup() int {
	pgid := 0
	_ = s.control(func(fd int) error {
		v, err := unix.IoctlGetInt(fd, unix.TIOCGPGRP)
		if err == nil {
			pgid = v
		}
		return err
	})
	return pgid
}

func (s *session) readLoop() {
	defer close(s.readDone)
	buf := make([]byte, MaxChunkBytes)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			s.appendOutput(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

func (s *session) appendOutput(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for s.buffered >= MaxBufferedBytes && !s.stopping {
		s.cond.Wait()
	}
	if s.buffered >= MaxBufferedBytes {
		// The session is ending and nobody drains it: drop the rest.
		return
	}
	// Append to the newest chunk while no reader has seen it, which keeps
	// keystroke echoes from turning into many one-byte chunks.
	if n := len(s.chunks); n > 0 && s.chunks[n-1].Seq > s.delivered && len(s.chunks[n-1].Data)+len(data) <= MaxChunkBytes {
		s.chunks[n-1].Data = append(s.chunks[n-1].Data, data...)
	} else {
		s.lastSeq++
		s.chunks = append(s.chunks, Chunk{Seq: s.lastSeq, Data: append(make([]byte, 0, len(data)), data...)})
	}
	s.buffered += len(data)
	s.lastSeen = time.Now()
	s.broadcastLocked()
}

func (s *session) writeLoop() {
	defer close(s.writeDone)
	for {
		select {
		case <-s.stop:
			return
		case b := <-s.input:
			if _, err := s.ptmx.Write(b); err != nil {
				return
			}
		}
	}
}

func (s *session) waitLoop() {
	err := s.cmd.Wait()
	code := -1
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		code = 0
	case errors.As(err, &exitErr):
		code = exitErr.ExitCode()
	}
	s.mu.Lock()
	s.exitCode = &code
	s.mu.Unlock()
	close(s.exited)

	select {
	case <-s.readDone:
	case <-time.After(drainGrace):
	}
	s.terminate(ReasonExited)
}

func (s *session) checkIdle() {
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return
	}
	since := time.Since(s.lastSeen)
	if since < s.m.idle {
		s.idleTimer.Reset(s.m.idle - since)
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	s.terminate(ReasonIdle)
}

// terminate ends the session once; the first reason wins. It hangs up the
// shell's process group and the terminal's foreground group, kills both
// after a grace period, and closes the PTY. It returns at once; s.done is
// closed when everything is gone.
func (s *session) terminate(reason string) {
	s.stopOnce.Do(func() {
		s.mu.Lock()
		s.stopping = true
		s.reason = reason
		s.cond.Broadcast()
		s.mu.Unlock()
		close(s.stop)
		s.idleTimer.Stop()
		go s.shutdown()
	})
}

func (s *session) shutdown() {
	groups := []int{s.pid}
	if fg := s.foregroundGroup(); fg > 0 && fg != s.pid {
		groups = append(groups, fg)
	}
	signalGroups(groups, syscall.SIGHUP)
	signalGroups(groups, syscall.SIGCONT)
	select {
	case <-s.exited:
	case <-time.After(killGrace):
	}
	signalGroups(groups, syscall.SIGKILL)
	select {
	case <-s.exited:
	case <-time.After(5 * time.Second):
	}
	_ = s.ptmx.Close()
	<-s.readDone
	<-s.writeDone

	s.mu.Lock()
	s.ended = true
	reason, code := s.reason, -1
	if s.exitCode != nil {
		code = *s.exitCode
	}
	s.broadcastLocked()
	s.mu.Unlock()

	s.m.logf("terminal: close session=%s project=%s pid=%d reason=%s exit=%d", s.id, s.projectID, s.pid, reason, code)
	time.AfterFunc(endedRetention, func() { s.m.forget(s) })
	close(s.done)
	s.m.live.Done()
}

func signalGroups(groups []int, sig syscall.Signal) {
	for _, pgid := range groups {
		_ = syscall.Kill(-pgid, sig)
	}
}

func (s *session) read(done <-chan struct{}, afterSeq int64, wait time.Duration) (ReadResult, error) {
	var timer *time.Timer
	if wait > 0 {
		timer = time.NewTimer(wait)
		defer timer.Stop()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if afterSeq > s.lastSeq {
		return ReadResult{}, errAhead
	}
	s.ackLocked(afterSeq)
	for {
		res := s.collectLocked(afterSeq)
		if len(res.Chunks) > 0 || res.Closed || timer == nil {
			return res, nil
		}
		if s.waiter != nil {
			close(s.waiter)
		}
		mine := make(chan struct{})
		s.waiter = mine
		notify := s.notify
		s.mu.Unlock()

		stop := false
		select {
		case <-notify:
		case <-mine:
			stop = true
		case <-timer.C:
			stop = true
		case <-done:
			stop = true
		}

		s.mu.Lock()
		if s.waiter == mine {
			s.waiter = nil
		}
		if stop {
			return s.collectLocked(afterSeq), nil
		}
	}
}

var errAhead = errors.Join(ErrInvalid, errors.New("after_seq is ahead of the output"))

func (s *session) ackLocked(afterSeq int64) {
	if afterSeq <= s.acked {
		return
	}
	drop := 0
	for drop < len(s.chunks) && s.chunks[drop].Seq <= afterSeq {
		s.buffered -= len(s.chunks[drop].Data)
		drop++
	}
	if drop > 0 {
		s.chunks = append(s.chunks[:0:0], s.chunks[drop:]...)
		s.cond.Broadcast()
	}
	s.acked = afterSeq
}

func (s *session) collectLocked(afterSeq int64) ReadResult {
	res := ReadResult{NextSeq: afterSeq, Truncated: afterSeq < s.acked}
	total := 0
	for _, c := range s.chunks {
		if c.Seq <= afterSeq {
			continue
		}
		if len(res.Chunks) >= MaxReadChunks || (len(res.Chunks) > 0 && total+len(c.Data) > MaxReadBytes) {
			break
		}
		res.Chunks = append(res.Chunks, Chunk{Seq: c.Seq, Data: append([]byte(nil), c.Data...)})
		total += len(c.Data)
		res.NextSeq = c.Seq
	}
	if res.NextSeq > s.delivered {
		s.delivered = res.NextSeq
	}
	if s.ended && res.NextSeq == s.lastSeq {
		res.Closed = true
		res.Reason = s.reason
		if s.exitCode != nil {
			code := *s.exitCode
			res.ExitCode = &code
		}
	}
	return res
}
