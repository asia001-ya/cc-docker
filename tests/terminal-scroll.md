# Terminal scroll regression

Run `npm run dev`, then open `http://localhost:5420/tests/terminal-scroll.html`.
This fixture uses the application's xterm options, scrollbar styles, and history event handler. It never connects to a container.

1. Enable **Mouse reporting** (DECSET 1003 + SGR, as used by Claude) and **WebGL**.
2. Drag the scrollbar upward and release. Move back over the text and use the wheel. The viewport must stay in history and move in the wheel's direction; the PTY input count must not increase while browsing history.
3. Append lines, or enable live output. `bottom` should increase while `viewport`, first row, and last row remain unchanged. Rows must remain consecutive visually and `ordered=true`.
4. Click the terminal and type a character. This intentional input should return to the prompt and increase the PTY input count.
5. Reset history, disable mouse reporting, and repeat scrolling with the DOM renderer. xterm's own local scrolling should continue to work.

For comparison, disable **History guard**, enable mouse reporting, drag upward, then move over the text and wheel. xterm 6 treats the SGR hover report as user input and returns to the bottom before forwarding the wheel to the application.

The automated tests in `src/lib/terminalScroll.test.ts` cover event routing, wheel units/fractions, returning to the bottom, alternate screens, and listener cleanup. The browser fixture additionally exercises real xterm mouse handling and rendering. It does not validate tmux's own copy-mode or replay of an old backend snapshot.
