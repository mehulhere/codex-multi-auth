# Check Reset Times and Tailscale Recovery Design

## Goal

Make `codex-multi-auth check` show the full local reset date and time for both quota windows on every successfully probed account, and ensure Tailscale is connected before account probing.

## Design

Quota summaries will retain their current inline structure, but every available `resetAtMs` value will render as a local date and 24-hour time, including resets later on the current day. Missing reset metadata remains omitted rather than fabricated.

The `check` command will run a best-effort Tailscale preflight before the existing account health check. A focused platform helper will:

1. Find `tailscale` on the current PATH, or use `flatpak-spawn --host tailscale` when running in a Linux sandbox.
2. Read `tailscale status --json` and accept `BackendState: Running` as healthy.
3. If the backend is not running, attempt `tailscale up`, then verify status again.
4. If the CLI is unavailable or recovery fails, print a warning and continue the account check.

The helper will not install Tailscale, change authentication, or make Tailscale a prerequisite for account health checks. This keeps the feature safe on systems where Tailscale is intentionally absent.

## Testing

Formatter tests will pin the local timezone and assert full date-and-time output for same-day and later reset timestamps. Tailscale tests will inject command execution so they cover direct CLI success, sandbox host fallback, disconnected recovery, and non-fatal failure. The command test will verify that the preflight happens before account probing.
