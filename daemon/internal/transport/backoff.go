package transport

import (
	"math"
	"math/rand/v2"
	"time"
)

// BackoffConfig controls bounded exponential backoff with equal jitter.
type BackoffConfig struct {
	Base   time.Duration
	Max    time.Duration
	Factor float64
	// Random returns a float64 in [0.0, 1.0). Defaults to rand/v2.Float64.
	Random func() float64
}

// DefaultBackoff matches the Mini App's relay client backoff curve.
var DefaultBackoff = BackoffConfig{
	Base:   500 * time.Millisecond,
	Max:    30 * time.Second,
	Factor: 2,
}

func (b BackoffConfig) withDefaults() BackoffConfig {
	if b.Base <= 0 {
		b.Base = DefaultBackoff.Base
	}
	if b.Max <= 0 {
		b.Max = DefaultBackoff.Max
	}
	if b.Max < b.Base {
		b.Max = b.Base
	}
	if b.Factor < 1 {
		b.Factor = DefaultBackoff.Factor
	}
	if b.Random == nil {
		b.Random = rand.Float64
	}
	return b
}

// ComputeBackoffDelay computes the equal-jitter retry delay for attempt (0-based).
// Half the ceiling is fixed and half is random, avoiding both zero-delay tight
// loops and thundering-herd lockstep reconnects.
func ComputeBackoffDelay(attempt int, cfg BackoffConfig) time.Duration {
	cfg = cfg.withDefaults()
	if attempt < 0 {
		attempt = 0
	}
	mult := math.Pow(cfg.Factor, float64(attempt))
	ceiling := float64(cfg.Base) * mult
	if math.IsInf(ceiling, 0) || math.IsNaN(ceiling) || ceiling > float64(cfg.Max) {
		ceiling = float64(cfg.Max)
	}
	r := cfg.Random()
	if r < 0 {
		r = 0
	}
	if r >= 1 {
		r = math.Nextafter(1.0, 0.0)
	}
	delay := ceiling/2.0 + (ceiling/2.0)*r
	if cfg.Base >= time.Millisecond {
		ms := math.Round(delay / float64(time.Millisecond))
		if ms < 1 {
			ms = 1
		}
		return time.Duration(ms) * time.Millisecond
	}
	if delay < float64(time.Nanosecond) {
		return time.Nanosecond
	}
	return time.Duration(math.Round(delay))
}
