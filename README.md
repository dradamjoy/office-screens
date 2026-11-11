# Office Screens

Phone-controlled looping displays for the office TVs.

- **Control panel (phone):** `https://dradamjoy.github.io/office-screens/`
- **TV page (each TV's browser):** `https://dradamjoy.github.io/office-screens/tv/`

## How it works

- Each TV opens the TV page in its web browser (Silk on Fire TV), picks which TV it is, and remembers that choice. No sign-in on the TV.
- A TV plays either **one video nonstop** or a **slideshow** of photos, videos and PDF slides.
- The TV saves every file it needs on the TV itself and plays from the saved copies, so it keeps playing when the internet drops. The page also works offline after a restart (service worker).
- TVs check for changes every 10 seconds and check in once a minute, so the control panel can show whether each TV is playing.
- The power switch blacks out the screen. It does not turn the TV's power off.

## Backend (Supabase project `office-screens`)

| Table | Who can read | Who can change |
| --- | --- | --- |
| `screens` | anyone (TVs) | admins |
| `media` | admins | admins |
| `checkins` | admins | TVs via `tv_checkin()` only |

Files live in the public `media` storage bucket. Only admins can upload or delete.

### Admins

Admins are listed in `private.admins`. A new login becomes an admin when it is created with a one-time setup code from `private.setup_codes`. To let someone else manage the TVs, insert a new code and give it to them:

```sql
insert into private.setup_codes (code) values ('JOY-XXXX-XXXX');
```

### File size

The free Supabase plan accepts files up to 50 MB. On the Pro plan, raise the limit in Supabase (Storage > Settings) and update `maxFileMB` in `config.js`.

## Files

- `index.html`, `app.js`, `app.css`: control panel
- `tv/index.html`, `tv/tv.js`: TV player
- `tv/sw.js`: keeps the TV page available offline
- `config.js`: Supabase address and public key
