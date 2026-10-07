// Disposing an xterm.js terminal. While the program in the terminal has mouse tracking on, xterm
// adds a document-level `mouseup` listener on `mousedown` and removes it only from that listener
// itself. `Terminal.dispose()` does not remove it, so a terminal disposed with a button held
// leaves a listener that throws on every later mouseup anywhere in the window. `reset()` turns
// mouse tracking off, which removes the listener.

/** The part of xterm's `Terminal` that `disposeTerminal` uses. */
export interface DisposableTerminal {
	reset(): void;
	dispose(): void;
}

/** Disposes `terminal`; `opened` says whether `open()` ran (xterm binds its mouse listeners there). */
export function disposeTerminal(terminal: DisposableTerminal, opened: boolean): void {
	if (opened) {
		try {
			terminal.reset();
		} catch (err) {
			console.warn("agent-sessions: terminal reset before dispose", err);
		}
	}
	terminal.dispose();
}
