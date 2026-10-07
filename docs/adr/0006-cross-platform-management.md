# ADR 0006: Cross-platform package management

The manager runs on Linux, macOS and Windows through the CLI, native command and agent tool. This supersedes ADR 0004's Linux-only payload-read requirement. Node 22.14 or newer and Git for repository sources remain required.

Portable Node filesystem APIs provide canonical containment, symlink rejection and file identity checks, but no portable descriptor-relative directory traversal. Reads validate the parent chain and regular-file identity before opening, compare the opened handle, and revalidate paths after reads. Linux additionally verifies descriptor paths when `/proc/self/fd` is available. Detected replacements fail closed. No platform claims protection against an adversarial process concurrently swapping a source or managed directory through an ABA sequence; those directories must not be concurrently writable by untrusted processes.

Staging ownership uses an opened directory handle where supported and a captured filesystem identity on Windows, where Node cannot portably open directories. Checks precede cleanup and publication; validated payload edits remain protected by fingerprints. Scratch paths use the native temporary directory. Windows junctions, symlinks, reserved names and escaping paths remain rejected.

CI runs native manager and bundled CLI lifecycle tests on all three operating systems. Unix-only runtime hook fixtures stay on Linux rather than masquerading as manager portability coverage. Independent standards and spec reviews must be clean before merge. npm release is separate.
