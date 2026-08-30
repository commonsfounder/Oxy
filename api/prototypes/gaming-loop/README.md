# PROTOTYPE — cross-platform gaming loop

Question: can one Adam game-session state model cover PC keyboard/mouse, PC controller,
PlayStation 5, and Xbox play while observation and input remain replaceable platform adapters?

This is throwaway logic exploration, not a production gaming feature. It has no real screen
capture, controller injection, console connection, account access, or game integration. It
simulates the normalized boundary so the state transitions and safety rules can be driven by
hand before hardware or platform APIs are chosen.

Run it with:

```sh
npm run prototype:gaming
```

The prototype keeps all state in memory. Use `help` inside it to see commands.
