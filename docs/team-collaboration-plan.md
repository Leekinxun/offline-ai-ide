# Team Collaboration Model Proposal

## Goal
Enable multiple invited users to collaborate inside the same programming team workspace with practical, low-friction features.

## Recommended rollout

### Phase 1: Shared workspace + presence
1. Team creation and invite links/codes
2. Team member list and roles (owner/admin/member/viewer)
3. Shared workspace binding for a team
4. Presence: who is online, active file, cursor line, current activity
5. Team chat/channel separated from personal AI chat

### Phase 2: Shared editing and coordination
1. File lock / soft claim indicator
2. Shared open-file status
3. Live file refresh when others save
4. Operation feed: who created/renamed/deleted/saved what
5. Comment/annotation on file ranges
6. Task board linked to files and assignees

### Phase 3: Real-time co-editing
1. True collaborative editing for same file
2. Conflict resolution / merge hints
3. Follow mode (jump to teammate cursor)
4. Shared terminal sessions with permission control

## Most practical features
- Presence and active-file awareness
- Shared save/update notifications
- Soft file claiming to reduce collisions
- Team operation timeline
- File comments and task assignment
- Shared chat with @mentions

These give most of the collaboration value before building full OT/CRDT co-editing.

## Suggested permissions
- Owner: manage team, workspace, roles
- Admin: invite/remove members, manage files
- Member: edit files, create tasks/comments
- Viewer: read-only access, comments optional

## Data model sketch
- teams
- team_members
- team_invites
- team_workspaces
- team_presence
- team_activity_events
- team_comments
- team_tasks
- optional: collaborative_sessions

## Technical approach

### Short-term (low risk)
- Reuse existing auth and workspace model
- Add team scope IDs to websocket channels
- Broadcast file tree refresh and file-save events
- Persist activity feed and comments in backend JSON or lightweight DB

### Mid-term
- Introduce a durable DB for teams/invites/activity/comments
- Add presence heartbeat and member permissions
- Add optimistic file claims and stale-claim recovery

### Long-term
- Add CRDT/OT for same-file real-time editing
- Add replay/audit trail and branch-based collaboration flows

## UX notes
- Team switcher near workspace switcher
- Presence pills in sidebar/top bar
- File tree badges: editing / claimed / conflict
- Team activity drawer
- Inline comment anchors in editor gutter

## Why this order
Real-time shared editing is expensive and risky. Presence, save-sync, claims, comments, and task coordination deliver immediate value with much lower complexity.
