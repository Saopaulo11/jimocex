# Brand assets

These files and `src/components/brand/LogoMark.tsx` hold the only copies of the
JC monogram geometry in the project. Nothing else draws it.

| File | Use |
| --- | --- |
| `jimocex-mark.svg` | monogram, transparent background |
| `jimocex-mark-mono.svg` | monogram in `currentColor`, for print and light backgrounds |
| `jimocex-logo-dark.svg` | full lockup on brand navy |
| `jimocex-logo-light.svg` | full lockup on ivory |
| `../../src/app/icon.svg` | favicon / app icon, monogram on navy |

## Replacing the mark with the final artwork

The monogram here is drawn from the approved direction — hexagonal frame, angular
JC, flat two-tone gold — and is a stand-in until the original vector is supplied.
It is NOT a new concept, and the geometry should not be redesigned.

To swap in the original, change the paths in these five places and nowhere else:

1. `src/components/brand/LogoMark.tsx` — everything in the app renders from here
2. `public/brand/jimocex-mark.svg`
3. `public/brand/jimocex-mark-mono.svg`
4. `public/brand/jimocex-logo-dark.svg` and `-light.svg`
5. `src/app/icon.svg`

In the React component keep the `var(--jc-gold*)` colour references rather than
hard-coding hex, so the mark continues to follow the theme.

## Usage

```tsx
import { Logo } from "@/components/brand/Logo";

<Logo variant="full" size={32} tagline />   // marketing
<Logo variant="compact" size={26} />        // headers
<Logo variant="mark" size={24} />           // tight placements
<Logo variant="compact" monochrome />       // light backgrounds
```

Gold is restrained by design: in the lockup only "Cex" and the monogram carry it.
