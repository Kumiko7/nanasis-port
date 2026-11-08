# Story viewer

Version: 0.3

A local, offline PC viewer for the story scenes in your own archived copy of the game.
It reads the files copied from BlueStacks, decrypts them on the fly, and plays them in your browser
with a layout matched to the game (1136×640 design resolution, scaled to the window).
Nothing is uploaded anywhere and no game files are bundled with this code; fonts and art are read
from your own APK and archive at runtime.

## Requirements

The viewer folder is self-contained on Windows (x64); nothing needs installing:

| Folder | Contents |
|---|---|
| `start.bat` | starts the viewer (this README sits next to it) |
| `scripts/` | the viewer's Python code: the server and the build / sync tools |
| `archive/` | the game data, `archive/files/` as copied from BlueStacks (not part of the viewer's code) |
| `web/` | the browser side (HTML, CSS, JavaScript) |
| `python/` | embeddable Python 3.10 with `pycryptodome` (the only dependency, see `requirements.txt`) |
| `tools/vgmstream/` | `vgmstream-cli` for decoding the game's audio. The server writes the game's HCA key to `archive/files/download/.hcakey` so vgmstream doesn't have to guess it (a guess fails on tracks that open with long silence and decodes them as loud noise) |
| `data/` | built indexes and database, plus what was taken from the APK: `fonts/` (Rodin for text, Kafu Techno for titles, FOT-Zerksie for the movie and sound player times), `builtin/builtInCharaFacePosition.txt` and `ui/` (the game's UI sprites: choice banner, backlog frames, tap ring, MENU triangle, sound player buttons and frames) |

All it needs besides itself is the game data: `archive/files/` inside the viewer folder (a folder next to the
viewer, `../archive/files`, also works, and `T7S_ARCHIVE` overrides the location). The APK is no longer needed.

Also needed: a current browser (Chrome, Edge or Firefox). ADB only if you use `scripts/sync.py` to pull new data
from BlueStacks.

To use a system Python instead: Python 3.8+ and `pip install -r requirements.txt`.

## Run

```
start.bat
```

or `python\python.exe scripts\server.py` and open http://127.0.0.1:7777. On first run `start.bat` builds `data/`
(`python\python.exe scripts\sync.py --no-pull`) if it is missing. The server also answers on the IPv6 loopback (`::1`),
so http://localhost:7777 is as fast as 127.0.0.1 (Windows tries `::1` first). It is still reachable only from
this PC.

### Episode select

Works like the in-game エピソード screens. The top screen has the category tabs (メイン / サブ / イベント with
読破済 counts), each category's series banners, a オススメエピソード card (first unread story) under each main
series, キャラ検索 (search titles and series/chapter names) and 中断エピソード (stories you suspended).
Inside a series: chapters → stories. NEW! marks stories you have not finished, 未読のみ表示 filters to those,
and the (i) button shows エピソード詳細 with the characters who appear (MAIN ring for main characters).
Right-click a story to turn its NEW! off or back on (marks it read / unread); right-click a series or chapter to
do it for every story inside. In 中断エピソード, × forgets where a story was suspended.

設定 holds text and auto speed, voice / BGM / SE volume, player name and the menu BGM
(default `bgm_system_006`; the game has no `bgm_system_003`). Both speed sliders start at the game's defaults and
reach beyond the game's own choices; the markers under them show where the game's settings sit (pink = default)
and clicking one jumps to it. Text speed passes through the game's four steps (遅い / 普通 / 速い / 最速 =
100 / 50 / 10 / 0 ms per character) and goes down to 200 ms; at auto speed 50 the timing is the game's, and each 25
either way halves or doubles the wait. Menus play the game's button tap / cancel sounds and its green tap ring.

### Sound player

サウンド (bottom left of the top screen, where the game has 一括DL) opens the game's サウンドプレイヤー, laid out
from its scene: categories (ボーカル / インスト / ソロ歌唱 / ボイスドラマ, 271 tracks from `m_sound_player`) and your
playlists on the left, the chosen group's tracks in the middle, the player on the right (jacket, seek bar,
shuffle / previous / play / next / repeat off → all → one song). Click a track to play the list from it; the
playing group shows the game's equalizer.

- ••• on a track: 追加先プレイリスト picks a playlist to add it to (or makes one if there is none); inside a
  playlist, プレイリストから削除 removes it.
- ✎ on a playlist: rename it, クイック追加 (add every track of the chosen types and artists), プレイリスト削除.
- Drag a track onto a playlist to add it; drag inside a playlist to reorder.
- Limits are the game's: 10 playlists, 300 tracks each. Playlists, shuffle and repeat are stored in your browser.
- Tracks play on the BGM channel (設定's BGM音量). Keys: Space = play / pause, ← / → = previous / next track,
  Esc / Backspace = close a menu, then leave.

ムービー (the viewer's own tab, not in the game) lists the 96 full-screen story movies in reading order under
their series, then ライブMV (the 137 videos that play behind the rhythm game, with their song) and the game's other
videos (`movie.mp4`, the two live tutorials, the トゲノスキマ PV and the フリフリモード tutorial). The 93 looping story
movies are left out: they are animated backgrounds (confetti, rain, swirls) rather than scenes. The nine
"-5th Anniv. Live ver.-" MVs are concert footage whose audio (`LiveCut_*`) was never in the game's data, so they
play silent (音声なし). Each row shows a frame (an MV shows its song's jacket), its length and what plays with it. Clicking one plays it full screen with the sound the story gives
it: voice and music cues timed to the video, and the scene's BGM / looping SE underneath. Click (or Space / Enter / →)
for the same SKIP / pause / seek controls as in stories; SKIP, Esc, Backspace or right-click close it. ••• lists the
episodes the movie appears in and opens the story at that page.

### Story player

The `◀MENU` button opens the game's toolbar:

| Button | What it does |
|---|---|
| 設定 | same settings as above |
| スキップ | skip to the end of the episode |
| オート | auto-advance, timed as in the game at the default オート速度: a line whose voice is still playing when the text finishes moves on as the voice ends; otherwise it waits 40 frames (30 fps) plus 1.5 / 2 / 3 s for 1 / 2 / 3 rows |
| 早送り | fast-forward until clicked or a choice appears |
| ログ･巻戻し | backlog; ▶ replays a line's voice, 巻戻し rewinds to that page (right-click closes it) |
| すべて非表示 | hide all UI (click to show it again) |
| 中断する | leave the episode and resume from that page next time |
| 閉じる | close the toolbar |

At the end of an episode: 次のエピソードへ continues through the series (into the next chapter when a chapter
ends), and Enter / Space picks it. 一覧に戻る returns to the list containing the episode you were reading.
Backspace on the first page of an episode reached this way goes back into the previous one.

Pages advance as the game's do: a page with `AutoMoveFrame` moves on by itself after that many frames (after its
voice), and any other page, text-less ones included, waits for a click. Clicking during a fade-out or wipe that
holds the page ends it at once, and a click ends a title card early; clicking on a scene transition (a text-less
page that advances by itself) also runs through the text-less pages after it without their animations, stopping
at the next line, choice, title card or full-screen movie.

Full-screen movies hide the story UI; click (or Space / Enter / Esc) to show the game's SKIP button,
play/pause and seek bar. The movie's music and voice are separate tracks kept in sync with the video.

Keys: click / Space / Enter = next, ← / Backspace = back one line, hold Ctrl = fast-forward, A = auto,
L or wheel up = backlog, H = hide UI, Esc = toolbar. F = fullscreen everywhere (menus, story,
movies, dialogs, backlog).

- Choices: 1–9 pick, ↑ / ↓ move, Space / Enter pick the highlighted one.
- Movies: Space / Enter / Esc / → show or hide the SKIP / seek controls (they stay until toggled, as in the game); Backspace / ← go back to the line before it.
- Dialogs: Enter / Space pick the main button, Esc / Backspace cancel. On the episode-end dialog, Backspace returns
  to the episode's last line.
- Backlog: Esc / L / Backspace / right-click close it, ↑ / ↓ scroll.
- Menus: Esc / Backspace go back a level.

Read state, bookmarks and settings are stored in your browser.

Deep links (useful for bookmarking or screenshots): `#s=<scenario id>&p=<page>` opens a story at a page,
`#m=<category>:<layer>,...` opens a menu level; add `&voice=0` to start without voices, `&ts=1` for instant
text, `&tb=1` to open the toolbar, `&pop=settings|help|log|play|info` (+ `&id=<scenario id>`) to open a dialog,
`#pop=sound` opens the sound player.

## Data

The archive in `archive/files` holds everything the game has: all 1,350 story scripts, all art,
all 189 story movies, and every voice line that exists. 384 referenced voice lines and one SE (`se_013b`) are
in no bank and not in the game's resource manifest (`resourceMeta/`), so they were never recorded; most are on
silent 「……」 lines, unvoiced speakers (PLAYER, crowd comments), or pages with no text. If content is ever added in-game, with BlueStacks running and ADB enabled:

```
python\python.exe scripts\sync.py
```

This copies new files into `archive/files` and rebuilds the database and indexes. Reload the page afterwards.

`python\python.exe scripts\sync.py --no-pull` rebuilds from the archive without touching the device.
`python\python.exe scripts\check_refs.py -v` lists any assets referenced by stories that are not in the archive.

## How it works

| Piece | File |
|---|---|
| Asset decryption (AES-128-CBC, `t7s-enc` header, optional LZ4) | `scripts/t7scrypt.py` |
| Game tables (`masterData/*.sql.enc`) → SQLite | `scripts/build_master.py` → `data/master.sqlite` |
| Asset index, audio cue → ACB bank index, face positions, movie list (`movies.json`), fonts from the APK | `scripts/build_index.py` → `data/` |
| CRI USM movies → MP4 (unmask, demux, remux) | `scripts/usm.py` |
| HTTP server: menu tree, scripts, sound player tracks (`/api/sounds`) and movies (`/api/movies`, `/usm/`), decrypted assets, audio decoded on demand by vgmstream (nothing cached on disk), fonts | `scripts/server.py` |
| Player engine (scene snapshots, characters, effects, audio, choices, modes) | `web/player.js` |
| Episode select, dialogs, toolbar | `web/app.js`, `web/index.html`, `web/style.css` |
| Sound player (groups, playlists, drag & drop, playback) and its ムービー tab | `web/sound.js`, `web/sound.css` |

Paths are set in `scripts/config.py` and can be overridden with `T7S_ARCHIVE`, `T7S_VGMSTREAM`, `T7S_PORT`
(and `T7S_APK`, only used to re-extract the fonts / face positions if `data/` is ever deleted).

### Format notes

- Script JSON: `Pages[]`, each a full snapshot of the scene: `BackGround`, `Charas[]` (7 or 13 fixed slots),
  `TextArea {Name, Dialogue}`, `Sound {VoiceFileName, BgmFileName, Se}`, `Effect`, `Filter`, `Item`,
  `InlineMovie`, `Title`, `SubTitle`, `Choices` / `ChoiceGroup`, `AutoMoveFrame`. A page without BGM stops the music.
- `PLAYER` in names and dialogue is the player-name placeholder (shown as あなた by default).
- Characters: `adv_chara_CCC_OO_FF` = body `adv_chara_CCC_OO` + face patch `adv_chara_CCC_OO_FF`, placed with its
  top-left at the `CCC_OO,x,y` entry of `characterFacePosition.txt`. Sprites are drawn 1:1, bottom-aligned.
- Slot centres (measured against the game): slots 0–6 at `568 + (slot − 3) × 160`, slots 7–12 at
  `568 + (slot − 9.5) × 160`. `IsShadow` / `IsNoise` are silhouette / noise effects (`IsTremble` is never read).
  Z-order follows the game's `Chara.setLayer`: `Layer` 1 / 2 / 3 is LayerFront / LayerMiddle / LayerBack (so 3 is
  the *back*), and a sprite given a Layer moves to the top of that layer; with `Layer` 0 it stays where it was and
  `IsFront` brings it to the top of its layer. All slots start in LayerBack in slot order.
  `FadeInSpeed` / `FadeOutSpeed` play the 40-frame (0.667 s) FadeIn / FadeOut clip at that speed (a smoothstep
  curve); 0 means instant. As in `Chara.ifPlayFadeAnimation`, both act on the page that carries them:
  `FadeInSpeed > 0` fades the sprite in from transparent, otherwise `FadeOutSpeed > 0` fades it out from opaque during
  that page, otherwise it is shown — but a fade still running from an earlier page plays on to its end. A slot left
  empty hides at once. So a character moving slots is two entries on one page, the old slot fading out and the new
  one fading in. Background crossfades are the 80-frame CrossFade clip.
- Draw order is the game's BackCanvas: background, movie, characters, item, effects. `BackGround.Color` tints the
  background image (it multiplies it, like `RawImage.color`) and defaults to white, so a page with neither image nor
  colour is white; `#000000FF` over an image is black. The item is drawn at native size, centred 106.6px above the
  stage centre, at `PositionX`.
- Script references in the tables usually include `.enc`, but not always (`bdmemory_0632_1111.json`, the second
  月代ユウ birthday), so look them up with and without it.
- Two voice names in scripts are typos the game itself can't play (`VO vo_ing3_000_13_01_001` in 3.0-013,
  `vo_ing3_003_01_01_12１` with a full-width digit); `clean_cue` in `scripts/check_refs.py` fixes them, so the viewer plays
  the recordings that are in the banks.
- Menu: `m_scenario_layer` rows are keyed by (category, layer_id) — ids repeat across categories. Layers sort by
  descending priority, stories by ascending priority. Category headers are the game's own labels.
  Characters per story come from `main_character_ids_string` / `sub_character_ids_string`; face icons are
  `ing_character_###_face`.
- Movies (`movie_*.mp4` in scripts) are stored as `<SHA-1 of the file name, upper-case hex>.acb` — plain MP4s
  with no audio track; `VideoVoiceFileName` / `BgmInfo` cues carry their sound. A page can hold both `Movie` and
  `InlineMovie` for the same file; `InlineMovie` is the one with the sound. Looping movies use the page's BGM, are
  part of the background (under the characters) and, as in `Movie.PrepareAsync`, keep running over consecutive
  pages that name the same file.
  The archive has 193 MP4s: the 189 story movies, the three videos above and a hashed copy of `live_tutorial.mp4`.
- The other 139 videos are CRI USM (`M<live music id>.enc`, `music_pv.enc`, `furifurimode_tutorial.enc`): H.264
  masked with the game's CRI key (`18279639311550860193`, from its string table). `usm.py` unmasks and remuxes
  them to MP4 in memory for `/usm/<file>.mp4` (no ffmpeg needed). An MV has no audio track; its music is the
  live's song cue (`m_live_music.acb`) from 0 s. The PV and tutorial carry HCA audio, which vgmstream reads from
  the USM (`/audio/usm:<file>.wav`).
- Cue names repeat across banks (e.g. `se_001` is a story SE in `AdvSE.acb` and the button tap in `BuiltIn.acb`);
  the server accepts `<bank.acb>@<cue>` to pick a specific one.
- Some episodes reuse another episode's voice cue names with different recordings (3.0-008 and 3.0-006 both use
  `vo_ing3_050_*`), so the server points each script's voice cues at its own bank (`ing3_101008_01.json` →
  `ing3_101008.acb`) when that bank has the cue.
- The game renders in linear colour space (PlayerSettings `m_ActiveColorSpace` 1), so translucent things blend in
  linear light (75% white over black is 225, not 191). The viewer re-alphas the translucent story UI art at load
  and the fade / flash overlays per keyframe so that ordinary sRGB blending lands where the game's does (checked
  against a game screenshot: within 3/255). Character fades and background crossfades blend two images and can't
  be corrected this way, so they still blend in sRGB.
- Choices are the game's VerticalLayoutGroup (722x82 units, spacing 77, padding left 50 / bottom 155, label 25px
  #323232); the auto / fast-forward mark is the game's AutoMark (`icon_auto` / `icon_fast_forward` at the text
  box's top-right corner); the movie seek bar is the prefab's 601x46.
- The story toolbar is the game's AdvPlayerMenu: the `menu_base` pill (100 → 900 px over the ShowMenu clip's
  0.2 s), the button sprites with their labels baked in (`btn_skip`, `btn_auto`, `btn_fast_forward`, `btn_log`,
  `btn_hide`, `btn_interrupt`, fading in one by one) and `btn_setting` sliding in; the movie SKIP is
  `btn_movie_skip`.
- The episode screens follow the game's scenes `level82` (top: category tabs `btn_episode_category(_selected)`, side
  buttons) and `level83` (lists): the CommonHeader (`base_header`, `btn_back_v2`, `btn_help_v2`,
  `base_header_sub_title_reduced`, the `btn_white_rectangle_reduced` 未読のみ表示 filter with `icon_check_box`, home
  `btn_mypage_v2`), the `base_scroll_list` list frame, episode nodes (`base_node_episode_reduced`, `cover_node_reduced`,
  `btn_info_v2`, `balloon_pink` NEW!), and the bottom buttons with the `base_footer` box. Popups are `base_popup` with
  `btn_blue_square` / `btn_white_rect_square_reduced` buttons; main characters get the `main` frame; the backlog uses
  `icon_face_base` / `icon_face_frame` and `btn_close`; movie controls are `btn_movie_start` / `btn_movie_stop` and the
  `movie_seek_bar_*` sprites; settings sliders mimic the game's option sliders (`OptionVolumeCursor`, speaker icons).
  Layout numbers come from the scenes' RectTransforms, read with typetrees generated from `DummyDll`; where the
  running game differs from the prefab (the NEW! badges' height), positions were measured from game screenshots.
- The game runs stories at 30 fps (Boot sets targetFrameRate 30), so AutoMoveFrame and other frame counts are
  1/30 s each; animation clips are timed in seconds. `adv_swoon(_fast)` / `adv_waking` reproduce the game's
  Swoon shader (decompiled from its GLES3 program): black eyelids opening from 0 to 2 / 1.4 / 1.6 with a soft
  21-step edge. Title, subtitle and single-subtitle cards and the text box (`frame_text_area`, `icon_next_delta`)
  use the game's own art and layout from the AdvPlayer prefab, read with typetrees generated from `DummyDll`.
- Effects follow the game's prefabs (`adv_*.and` bundles): fades and black / white wipes are 80-frame clips
  (`_2400`: 160), flashes 20 frames, all on Unity's smoothstep curve; `adv_slidein_black` grows from the right edge
  and holds, `adv_slideout_black` shrinks towards the left. The blur wipes are a 2000px soft-edged black panel (the
  `blur_left_black_mask_reduced` 9-slice, mirrored for `_right`) tweened 1 s OutSine. `adv_shake` jumps the scene
  (not the UI) to a random offset for 20 frames. Only effects marked `isBlocking` hold the page back (the fade-outs,
  the black / white wipes and `adv_fadein_white_2400`); the rest play while the text types. `adv_swoon(_fast)` /
  `adv_waking` use the game's durations and easings, but their shader is only approximated. An effect repeated on
  the next page is left as it is (still running, or held at its end) unless `SameEffectContinuousPlayMode` is 1
  (RePlay); shake is the exception and shakes every time. `adv_filter_*` used as an effect name does nothing, as in
  the game. The `Filter` sepia / gray are the game's URP volume profiles as colour matrices (gray: saturation −100;
  sepia: white balance +100, colour filter (1, .878, .552), saturation −60) over the scene and effects.
  BGM changes are a hard cut, as the game's `AdvBgm` does. A loop SE carries on only over pages that repeat it: any
  change of `LoopSeFileName` (a page without one included) or `IsStopSe` stops every SE, as `Sound.PrepareAsync`
  does. The text box opens and closes with its 10-frame clip; title and subtitle cards
  slide in with the Title / SubTitle clips and hold 70 frames when unvoiced.
- UI sprites in `data/ui/` were exported from the APK's Unity data with `scripts/extract_ui.py` (needs UnityPy, only to
  re-export); the blur wipe's sprite comes from the `adv_slidein_blur_left.and` bundle in the archive. Several are Unity 9-slices whose caps cover the whole image (e.g. `btn_choice` 61 + 89 = 150px), so
  the CSS slices 1px inside the caps to get a stretchable centre, as Unity does.
- Sound player: `m_sound_player` ids repeat across categories (ボーカル 1 and インスト 1 are different tracks), so
  tracks are keyed `<category>:<id>`; `acb` is the track's cue. The layout comes from the APK's scene `level101`,
  whose script components only read with typetrees generated from Il2CppDumper's `DummyDll`. Its sprites, plus
  the `bg_jacket_light` / `jacket_empty(_l)` textures, are in `data/ui/` (listed in `scripts/extract_ui.py`).
