# Voices Playground

## Local server restart

After each completed application change, run the relevant checks and `npm run build`, then restart the local production server with `npm start` before handing off. A browser refresh does not reload backend code.

Before restarting, identify the exact Voices Playground listener on `127.0.0.1:4310` and check that no scoring evaluations or Azure Voices Studio jobs are running or queued. If the server is busy, leave it running and tell the user why the restart was deferred. Verify the replacement server responds on port 4310 before reporting success. Leave open browser tabs and unsaved drafts untouched.
