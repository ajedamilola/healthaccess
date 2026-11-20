# HealthAccess competition presentation

Open **`HealthAccess.html`** in a modern browser for the portable, single-file presentation. All fonts, images, styles and controls are embedded. You can copy this file to another computer and present without internet, dependencies or a server. Optional links to repository documentation on the last slide require this repository.

**`index.html`** is the editable source version and also works directly from disk. Keep the `assets` folder, `deck.css` and `deck.js` beside that version.

The deck is designed for a **6–8 minute competition pitch**. Slides 1–12 tell the patient-focused story. Slides 13–14 are optional supporting material for the judges’ questions. Speaker notes are built into every slide.

## Presenting

| Action | Key |
| --- | --- |
| Next / previous | Arrow keys or Page Down / Page Up |
| First / last | Home / End |
| Slide overview | O |
| Speaker notes | N |
| Fullscreen | F |
| Blank / unblank the screen | B |
| Keyboard help | ? |
| Close a panel | Esc |

The bottom controls provide the same actions. On a touchscreen, swipe left or right. Use a URL fragment such as `index.html#6` to jump directly to a slide. Slide 6 has interactive USSD and SMS examples: choose a tab, then advance through four steps.

Slides 5, 7, 8, 9 and 10 feature the supplied frontend screenshots. Click a screenshot to inspect the full original. Slide 10 has six patient-portal views; use the buttons or focus the list and press Up / Down to switch between them. Esc closes the enlarged view.

Use the Print button or your browser’s print command to save a PDF. The print stylesheet puts one complete slide on each landscape page, including the two appendices. Enable background graphics and use no margins if the browser asks. Presenter notes and controls are excluded.

## Content and evidence

The presentation is based on the root [README](../README.md), [engineering overview](../docs/README.md), [architecture](../docs/architecture.md), [operations](../docs/operations.md), current backend source, and the user-supplied frontend screenshots in `images/`. The screenshots supersede the earlier documentation's description of the frontend as absent. They establish the visible interface; successful end-to-end integration or production deployment has not been inferred from them.

| Slides | Grounding |
| --- | --- |
| 1–3: promise, problem, solution | README product description; the problem statements describe the design challenge rather than research findings. |
| 4: Ada’s journey | Fictional scenario assembled from supported capabilities, not a customer or testimonial. |
| 5: emergency summary | Supplied emergency-summary screenshot plus `backend/online/src/modules/portal/`, `backend/online/src/domain/access.ts`, `backend/shared/src/policy.ts`. |
| 6: basic phone access | `backend/offline/src/channels/ussd.ts` and `sms.ts`; the compact demo paraphrases the flows and is not connected to a provider. |
| 7: care navigation | Supplied landing-page screenshot plus directory, emergency and offline channel code. The landing page's phone illustration contains fictional results. |
| 8: symptoms and medication | Supplied Assistant and Medications screenshots plus symptom, medication and reminder services. The captured empty states are preserved. |
| 9: patient control | Supplied channel-permissions screenshot plus shared access policy, portal services and access-event routes. The screenshot notes a session-local readback limitation. |
| 10: patient experience | Six supplied frontend views: Overview, My record, Emergency summary, Assistant, Medications and Channels. |
| 13–14: implementation stage | Backend documentation and supplied frontend evidence. Historical automated test totals are not presented as newly verified results. |
| 11–12: pilot and invitation | Proposed next steps based on documented gaps; no existing pilot, partnership, funding, patient count or clinical outcome is claimed. |

The patient portal images are actual user-supplied frontend screenshots. Inline frames focus parts of the originals for readability; clicking opens the complete image. Original files are unchanged. The campaign image, Ada's story and interactive SMS/USSD phone remain illustrative. Demo values, empty states and fictional facility results are not patient outcomes. No fabricated market statistics, real endorsements or treatment outcomes are included. SMS/USSD needs cellular coverage, and live provider provisioning and delivery require validation. Emergency search supplies contact listings, not ambulance dispatch.

### Selected frontend captures

| Source file in `images/` | Used for |
| --- | --- |
| `IMG-20261117-WA0061.jpg` | Web landing page and care-search illustration |
| `IMG-20261117-WA0063.jpg` | Patient overview |
| `IMG-20261117-WA0064.jpg` | Medication schedule creation |
| `IMG-20261117-WA0065.jpg` | SMS / USSD permission details |
| `IMG-20261117-WA0066.jpg` | Emergency-summary field selection |
| `IMG-20261117-WA0067.jpg` | Symptom assistant |
| `IMG-20261117-WA0070.jpg` | Patient record |
| `IMG-20261117-WA0071.jpg` | Phone verification and channels |

Other supplied screenshots remain available in `images/`; eight distinct captures were selected to keep the pitch focused. Demo medication values shown in the screenshots are source content, not recommendations.

## Visual assets

The cover photograph, `assets/healthaccess-cover.jpg`, was made with the built-in image generation tool and is labelled as illustrative in the deck. It does not depict an actual patient or customer. It was converted to JPEG for a smaller, offline-friendly deliverable. Final generation prompt:

> Use case: photorealistic-natural. Asset type: a competition presentation cover image for HealthAccess, a patient-controlled emergency health summary and care navigation project for Nigeria. Create a highly polished, authentic editorial healthcare photograph, landscape 3:2 crop. An adult Nigerian woman in her early thirties, natural deep brown skin, short natural braided hair, wearing an understated burnt-orange blouse, standing outdoors in the shaded entrance of a modest contemporary community clinic in Lagos. She holds a simple black basic feature phone gently at waist/chest height; the physical buttons are visible. Her expression is thoughtful and quietly hopeful, looking just slightly off camera. Frame from waist upward with subject on center-right, environmental architectural context and soft greenery. Contemporary West African setting, clean cream walls, deep forest green door trim, warm afternoon sun on one edge of her face. Sophisticated documentary magazine photography, real skin texture, restrained earthy palette of forest green, ivory, terracotta and amber. Gentle film grain, shallow depth of field, beautiful natural lighting. No text, no typography, no brand logos, no watermark, no medical symbols, no lab coats, no hospital beds, no distress, no additional people. This is illustrative campaign imagery, not a real patient testimonial.

The mark, icons, basic-phone illustration, diagrams and screenshot frames are SVG/HTML/CSS. Frontend images are embedded in the portable export alongside the cover image. Space Grotesk, Lato and Noto Serif Display are bundled locally so the presentation renders without web font requests. Font license notices are in `assets/fonts/`.

## Editing

- `index.html`: slide copy, diagrams and per-slide speaker notes.
- `deck.css`: visual design, 16:9 stage, responsive controls and print layout.
- `deck.js`: navigation, overview, notes, touch gestures and the phone demonstration.

Backend source and runtime configuration are not used or changed by this presentation.

After editing the source files, regenerate the portable version with:

```sh
node presentation/build-portable.mjs
```

The bundled `HealthAccess.pdf` is a snapshot for sharing and should be re-exported after content changes.

## Verification

The updated deck was checked in Chrome at 1440 × 900 and at a 390px viewport. All 14 slides rendered without detected text clipping. All six frontend gallery tabs, enlarged screenshot view, gallery keyboard navigation, eight USSD/SMS demonstration steps, slide overview, notes, keyboard controls, blank-screen mode and fullscreen were exercised. The portable HTML was loaded with network access disabled: fonts and screenshots loaded with no external asset dependencies. The PDF contains 14 landscape pages, including the updated screenshot layouts.
