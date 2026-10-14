# Operator guide

Create the first admin using the locally held setup token. Administrators can configure provider settings, create support users, edit Ryan's future-call prompt and export sanitized call records. Support users can inspect conversations and timelines but cannot read/change credentials, manage users or export call records.

Connections: enter settings and a credential, then save. Saved credentials are never read back; a blank credential field preserves the existing encrypted value. Enter a replacement to rotate that provider credential. A settings change clears previous test status. Explicit OpenAI/Syncro read checks work when browser demos are enabled; otherwise offline demo checks are blocked. On a non-demo installation, read checks verify model/customer list access only; PBX checks remain blocked. Browser voice and test-ticket features require a user-run call to verify the account.

Conversations: search clinic/issue/transcript, filter outcome and date, and load further pages until the entire retained result set is displayed. Open a call for transcript, ticket reference and technical timeline. Synthetic ticket IDs begin with `DEMO-` and are not Syncro tickets. Redaction is imperfect; do not enter actual patient or authentication data into a demo.

Agent settings: Ryan is the default assistant. Saving creates a new immutable prompt version; historical calls keep their original version. Confirmation cannot be disabled. Audio recording is off. A test voice greeting and prompt revert UI are planned alongside voice integration.

Maintenance: the audit log includes setup, login, user creation, settings changes, connection checks and exports. Retention deletion, restore operations, password reset and user disable controls are not yet implemented. No purge endpoint exists in this milestone.

Browser demo: open Demo call, leave Demo ticket only selected, and Start demo call to talk with Ryan. For a real test ticket, select that mode and enter a permitted Syncro test customer ID first. Caller confirmation remains mandatory. Use End call to release the microphone. See browser-demo-calls.md.
