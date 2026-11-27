package secure

import (
	"bytes"
	"crypto/ecdh"
	"encoding/hex"
	"testing"
)

type fixedReader []byte

func (r *fixedReader) Read(p []byte) (int, error) {
	n := copy(p, *r)
	*r = (*r)[n:]
	return n, nil
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// noiseVector holds deterministic Noise_XX_25519_ChaChaPoly_SHA256 values
// generated from Go's github.com/flynn/noise and committed to both
// daemon/internal/secure/vector_test.go and miniapp/src/secure/noise.test.ts.
var noiseVector = struct {
	deviceIDHex      string
	prologueHex      string
	initStaticPriv   string
	initStaticPub    string
	respStaticPriv   string
	respStaticPub    string
	initEphPriv      string
	respEphPriv      string
	msg1Hex          string
	msg2Hex          string
	msg3Hex          string
	c2dPlaintextHex  string
	c2dCiphertextHex string
	d2cPlaintextHex  string
	d2cCiphertextHex string
}{
	deviceIDHex:      "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c",
	prologueHex:      "000000196167656e74696b2d6e6f6973652d70726f6c6f6775652d7631000100000006636c69656e74000000066465766963650000002056475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c",
	initStaticPriv:   "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e4f",
	initStaticPub:    "92ae943cc4f29c0a6b83222eb0c3024206809d15f7b78274f0d28211981ddf15",
	respStaticPriv:   "303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e6f",
	respStaticPub:    "5a5ceba4043f071dd664133c0120ad7e86ad55f430735449110238330ab00810",
	initEphPriv:      "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbe4f",
	respEphPriv:      "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcddde6f",
	msg1Hex:          "a0ccb3b25341f032cc587460b0ef7bd5465301492ae3606a2addaa58777a586b",
	msg2Hex:          "3676fee442ab4be2f21a20f690e898b95951e6748c164046631a733618eb6c47b50f79d702d8832657144d6d74091cc44d1fdb46ac9300582b273f446eef5a64aa64f42c350d6f480ec96704e882fbb9984c8268fe3bd85525e493bd1994d77c",
	msg3Hex:          "845dc94cf29b22c4963616688442bdea96726829e43af8d88665ff81c588ac42768ef85c7878d8d63591387ff3059688a689d4d2a2feb049e6637f81abb61d01",
	c2dPlaintextHex:  "7b2276223a312c226d6574686f64223a226465766963652e696e666f227d",
	c2dCiphertextHex: "8be4565790c1599d4ae87a50c255f17628956200bd021fbf1b85b041b68fef00ca028c302f72e48e7a0f83d128b3",
	d2cPlaintextHex:  "7b226f6b223a747275657d",
	d2cCiphertextHex: "32480a0144e40c3f0b5189b2d8cac585b8ea91144f22c221a5832d",
}

func TestNoiseCrossLanguageVector(t *testing.T) {
	v := noiseVector
	deviceID := mustHex(v.deviceIDHex)
	prologue := DevicePrologue(deviceID)
	if got := hex.EncodeToString(prologue); got != v.prologueHex {
		t.Fatalf("prologue = %s, want %s", got, v.prologueHex)
	}

	initStatic, err := ecdh.X25519().NewPrivateKey(mustHex(v.initStaticPriv))
	if err != nil {
		t.Fatal(err)
	}
	respStatic, err := ecdh.X25519().NewPrivateKey(mustHex(v.respStaticPriv))
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(initStatic.PublicKey().Bytes()); got != v.initStaticPub {
		t.Fatalf("initStaticPub = %s, want %s", got, v.initStaticPub)
	}
	if got := hex.EncodeToString(respStatic.PublicKey().Bytes()); got != v.respStaticPub {
		t.Fatalf("respStaticPub = %s, want %s", got, v.respStaticPub)
	}

	initRNG := fixedReader(mustHex(v.initEphPriv))
	respRNG := fixedReader(mustHex(v.respEphPriv))

	initiator, err := newHandshake(Config{
		Initiator:  true,
		StaticKey:  initStatic,
		Prologue:   prologue,
		VerifyPeer: acceptAll,
	}, &initRNG)
	if err != nil {
		t.Fatal(err)
	}
	responder, err := newHandshake(Config{
		Initiator:  false,
		StaticKey:  respStatic,
		Prologue:   prologue,
		VerifyPeer: acceptAll,
	}, &respRNG)
	if err != nil {
		t.Fatal(err)
	}

	msg1, err := initiator.WriteMessage(nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(msg1); got != v.msg1Hex {
		t.Fatalf("msg1 = %s, want %s", got, v.msg1Hex)
	}
	if _, err := responder.ReadMessage(msg1); err != nil {
		t.Fatal(err)
	}
	msg2, err := responder.WriteMessage(nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(msg2); got != v.msg2Hex {
		t.Fatalf("msg2 = %s, want %s", got, v.msg2Hex)
	}
	if _, err := initiator.ReadMessage(msg2); err != nil {
		t.Fatal(err)
	}
	msg3, err := initiator.WriteMessage(nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(msg3); got != v.msg3Hex {
		t.Fatalf("msg3 = %s, want %s", got, v.msg3Hex)
	}
	if _, err := responder.ReadMessage(msg3); err != nil {
		t.Fatal(err)
	}

	initSess, err := initiator.Session()
	if err != nil {
		t.Fatal(err)
	}
	respSess, err := responder.Session()
	if err != nil {
		t.Fatal(err)
	}

	c2dCT, err := initSess.Encrypt(mustHex(v.c2dPlaintextHex))
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(c2dCT); got != v.c2dCiphertextHex {
		t.Fatalf("c2dCT = %s, want %s", got, v.c2dCiphertextHex)
	}
	c2dGot, err := respSess.Decrypt(c2dCT)
	if err != nil || !bytes.Equal(c2dGot, mustHex(v.c2dPlaintextHex)) {
		t.Fatalf("c2d mismatch: %v", err)
	}

	d2cCT, err := respSess.Encrypt(mustHex(v.d2cPlaintextHex))
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(d2cCT); got != v.d2cCiphertextHex {
		t.Fatalf("d2cCT = %s, want %s", got, v.d2cCiphertextHex)
	}
	d2cGot, err := initSess.Decrypt(d2cCT)
	if err != nil || !bytes.Equal(d2cGot, mustHex(v.d2cPlaintextHex)) {
		t.Fatalf("d2c mismatch: %v", err)
	}
}
