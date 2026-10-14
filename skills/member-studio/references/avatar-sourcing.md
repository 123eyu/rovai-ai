# Avatar sourcing

An avatar identifies a member; it does not establish responsibilities, permissions, Runtime, or team authority.

## Timing and file handling

Present the visual plan before card confirmation. After confirmation, generate, download, or prepare the file in the current AgentRun and pass it promptly to `rovai member create`.

Prefer a separate file under `ROVAI_RUN_TMP` when available, or another controlled temporary directory readable by Core in this Run. Do not assume temporary files survive between Runs.

Pass the local path through `--avatar-file`. Do not write directly to `userData/member-avatars/` or use a remote URL as `avatarRef`. The product validates and strips private metadata, normalizes static image orientation and size, and stores one managed avatar file with display framing metadata. It does not create a second animated icon.

## Image requirements

- Use static PNG/JPEG by default. Use GIF only when supplied or explicitly requested by the user, within current product size and animation limits.
- Recommend one square 512 x 512 or 1024 x 1024 image, with a centered face or recognizable symbol. These are generation recommendations, not mandatory upload dimensions or aspect ratios.
- Keep identifying features inside the central circular safe area; use a simple background without text, watermarks, or complex borders.
- Submit only this avatar. Do not prepare a separate half-body portrait, small icon, or channel-specific image.

## Original generation

Follow the confirmed visual preference, name, role, and traits. Default to illustration, semi-realistic art, or the product's specified style; avoid a default likeness that could be mistaken for a real photograph.

For public or historical figures, use public professional references without claiming to reproduce the real person. For fictional characters, preserve requested qualities without copying a particular film, game, or illustration design.

Include the reference or name, role, 2-3 work traits, recommended dimensions, centered framing, circular safe area, simple background, and exclusions above in the generation prompt. Optional Rovai details, such as warm lamps, travel gear, or badge motifs, should support distinct identities rather than make everyone share one costume or profession.

## Source online

Use available, authorized search or network capabilities when the user chooses this method or generation is unavailable. Prefer:

1. The user's specified official source.
2. Public-domain or explicitly reusable collections.
3. Other sources with a clear source page and license.

Download the original image file, not a search thumbnail or unknown CDN hotlink. Retain the source page and available author, institution, license, or usage information. If provenance or permission is unclear, choose another image or omit the avatar.

## Fallback

Without an appearance request, omit `--avatar-file` and use the default avatar. For a confirmed appearance request, use only capabilities actually available and authorized; if image preparation fails, offer the default avatar so the member can still be created. Never invent a path, URL, or result. A changed avatar plan follows the card confirmation rule.

## Validate

Visually check the centered square region based on the image's shorter side and the circular display mask. Keep the face or symbol and identifying features visible. The product uses the same file at different display sizes; a finished icon file is unnecessary.

Before creation, verify the readable PNG/JPEG/GIF, dimensions and bytes against `rovai member create --help`, framing, and current-Run path. Match the confirmed identity without inferring identity facts from the image.

For GIF, pass the animation intact and prefer a stable centered subject. Rovai applies one display framing region without cropping or re-encoding every frame. Oversized animations are rejected; do not promise automatic compression or easier GIF generation. Static channel covers are exported by the product when publishing, not prepared by the Agent.
