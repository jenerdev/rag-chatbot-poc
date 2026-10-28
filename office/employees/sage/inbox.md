# sage's inbox

Appended by `node office/office.mjs msg …`, ticked by `inbox sage --ack` (Rule 4). Newest last.

- [ ] M-026 · 2026-10-28 08:48 · from finn · T-016, what the entry does not say: the postcss claim rests on grepping next 15.5.28's dist for require('postcss'): build/webpack css blocks, the font loader, resolve-url-loader, the css minimizer, and compiled/@ampproject/toolbox-optimizer (AMP only; the app has no AMP page). I did not trace whether any runtime path reaches the AMP optimizer without an AMP page; that is the one thing to check before accepting R-64. Also new: z.config({ customError }) is process-global; schemas.ts is the only zod importer in the repo (grep), so nothing else is affected today.
