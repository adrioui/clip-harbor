//go:build !unix

package main

import "os/exec"

func configureCommandCancellation(_ *exec.Cmd) {}
