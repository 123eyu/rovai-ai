---
document_type: contract
contract: windows-private-storage-v2
status: accepted
source_version: v1.15
last_updated: 2026-10-29
---

# Windows Private Storage v2

Windows Private Storage v2 replaces [v1](windows-private-storage-v1.md). It preserves the v1 Desktop data-root layout,
local fixed NTFS admission, stable handle identity, protected DACL creation, non-inheritable handles and long-path blockers.
It adds the Instance Runtime Files Root as one protected Core child.

## 1. Runtime Files Root

Windows Desktop explicitly passes:

```text
--runtime-camp-files-root <data_dir>\runtime-files
```

For the default installation this is `%LOCALAPPDATA%\Rovai AI\Core\runtime-files`; explicit isolated Desktop roots use
their own `Core\runtime-files`. No attachment View is placed under user Home, roaming AppData or a shared cross-instance
directory. This exact child is the only allowed Runtime-root/data-dir containment exception and is derived data, not
Authority Attachment storage.

Core creates or admits the root through the existing native private-directory primitive: normalized native absolute path,
local fixed NTFS volume, stable opened identity, no reparse root, current-user owner, protected DACL limited to current user
and SYSTEM, and non-inheritable retained handles. The root marker and lock use private-at-birth file primitives. Directly
managed `.staging`, `camps`, operation, Camp, Entry and payload container directories use the same private-directory
admission; copied descendants inherit only the private user/SYSTEM ACL and final files are read-only hardened.

Existing unknown directories with inherited/broader ACL, reparse points, wrong owner or identity drift are rejected rather
than repaired and reused. Runtime receives only the current Camp's exact `attachments` child, never `<data_dir>`,
`runtime-files`, `camps`, Authority Attachment or another Camp.

### Runtime Fleet owner records

Within an already admitted Core root, the internal `runtime-fleet/owners` ledger uses ordinary Windows directory creation
and file access. Windows decides whether the requested operation is allowed. Fleet does not require an exact ACL template,
current-user ownership or permission to change ACLs, and does not migrate or repair existing directory/file permissions.
New directories and record files inherit normal Windows permissions. Reads request only read access.

Record updates still write and flush a unique sibling before atomically replacing the destination with write-through
publication. A failed write or replacement preserves the previous record. Real filesystem failures still propagate through
the existing error paths; unavailable durable storage is not replaced by an empty or in-memory ledger. Existing Run/epoch,
process ownership, stop receipt and cleanup acknowledgment rules are unchanged.

This replaces the Fleet-only inherited-to-protected ACL migration. Core/data-root admission, other private storage,
credentials, Named Pipes, Jobs and non-Windows storage behavior remain unchanged.

## 2. Platform qualification

Private storage implementation is necessary but not sufficient for Runtime access. All current `windows-x64` Adapter rows
remain `not_qualified`; each requires its own directory-authorization, read-only behavior, process lifecycle and sandbox
evidence before execution can receive a Camp View root. Windows readonly/DACL hardening is not described as strong
same-SID isolation.

## 3. Desktop Bootstrap composition

[Desktop Runtime Availability v1](desktop-runtime-availability-v1.md#8-windows-pre-ready-bootstrap-assessment) 补充独立
`LocalAppData Known Folder\\Rovai AI Bootstrap\\<instance-key>` 壳层 profile。它只容纳 Electron 本机状态与稳定实例锁，
不承载 Core authority 或 Runtime files；使用与正式 root 相同的 creation-time protected DACL / identity admission。
只有 primary 准备正式布局，失败不向该 profile 传递 Core data path。正式 v2 布局与 Runtime 平台资格不变。

## Windows Web credential exception

For Web credentials, `web-auth.json` inside an already admitted Core data directory accepts ordinary inherited file ACLs.
It does not require a protected flag, exact ACE count/principals/masks or permission to change the existing file's DACL.
Reads leave the file unchanged. New atomic siblings inherit the admitted directory and attempt DACL hardening before
writing credential bytes; failure of that optional hardening does not block real I/O. The native atomic replacement
remains the commit point. Directory admission, file identity/type and reparse checks remain mandatory.
Core/Server retain initial data-directory admission; subsequent credential I/O rechecks native directory path, volume
and stable identity without imposing the exact writable directory ACL template again on read-only Token lookup.

This exception does not relax the general private-file APIs, data-root admission, Named Pipe, Job or Runtime storage
policy, nor any non-Windows behavior. The complete lifecycle and error contract is
[Host Web v4](host-web-v4.md#windows-web-凭据可用性).

## References

- [Windows Private Storage v1](windows-private-storage-v1.md)
- [Camp Published Attachment View v1](camp-published-attachment-view-v1.md)
- [Windows Desktop Platform](../architecture/windows-desktop-platform.md)
