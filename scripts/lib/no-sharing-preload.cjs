'use strict';
// Preload (`node -r` / `tsx -r`): turn sharing off for this process and every child it starts. See no-sharing.cjs.
const { applyNoSharing } = require('./no-sharing.cjs');

applyNoSharing(process.env);
