"""One-off: export the game's UI sprites from the APK's Unity data into data/ui/ (for local use only).

The viewer ships the exported PNGs, so this only needs running again if data/ui is deleted.
Needs UnityPy (pip install UnityPy) in whichever Python runs it; the viewer itself does not.

usage: python scripts/extract_ui.py [path to base.apk]
"""
import json
import os
import sys
import tempfile
import zipfile

import config
import t7scrypt

SPRITES = [
    'btn_choice',            # choice banner (stars + note), 9-slice horizontally
    'log_base',              # backlog panel
    'log_text_base',         # backlog line bubble
    'frame_log_choice',      # backlog current-line frame
    'log_scroll_bar',
    'base_menu_button',      # MENU pill
    'icon_menu_delta',       # MENU triangle
    'eff_tapcircle',         # tap ripple
    'btn_movie_skip',
    # サウンドプレイヤー (scene level101)
    'subcategory_btn_off', 'subcategory_btn_on', 'subcategory_btn_on_o',   # group / song rows (9-slice)
    'subcategory_bg_reduced',                                              # song list panel
    'btn_white_rectangle_reduced',                                         # プレイリスト作成
    'btn_name_change', 'icon_soundplayer_option', 'triangle_w',
    'scrollbar_img_reduced', 'scrollbar_8px4px', 'soundplayer_seekbar', 'attention',
    'btn_soundplayer_play', 'btn_soundplayer_stop', 'btn_soundplayer_prev', 'btn_soundplayer_next',
    'btn_soundplayer_shuffle_off', 'btn_soundplayer_shuffle_on',
    'btn_soundplayer_repeat_off', 'btn_soundplayer_repeat_all', 'btn_soundplayer_repeat_single',
    'soundplayer_submenu_bg', 'base_common_square_white_alpha_blue_outline_2pt', 'balloon_arrow',
    'icon_check', 'btn_blue_square', 'btn_white_rect_square_reduced', 'icon_frame_mask', 'text_icon',
]
# plain textures (RawImage) used by the sound player
TEXTURES = ['bg_jacket_light', 'jacket_empty_l', 'jacket_empty']
# story title / subtitle cards: the number banner (01), the name banner (03), their accent lines (02, 04) and the
# sparkle
TEXTURES += ['scenariotetitlebar01', 'scenariotetitlebar02', 'scenariotetitlebar03', 'scenariotetitlebar04']
SPRITES.append('eff_scenariotetitle')
# the story text box (9-slice: name tab + body) and its next-line mark
SPRITES += ['frame_text_area', 'icon_next_delta', 'icon_auto', 'icon_fast_forward']   # + the auto / fast-forward mark
# the story toolbar (menu_base pill, its buttons, 設定) and the menus' back button
SPRITES += ['menu_base', 'btn_setting', 'btn_skip', 'btn_auto', 'btn_fast_forward', 'btn_log', 'btn_hide',
            'btn_interrupt', 'btn_back_v2']
# the episode screens (header, list, rows, tabs, side buttons), popups, backlog, movie controls and option sliders
SPRITES += ['base_header', 'btn_help_v2', 'base_header_sub_title_reduced', 'icon_check_box', 'btn_mypage_v2',
            'base_scroll_list', 'base_node_episode_reduced', 'cover_node_reduced', 'mask_node_episode', 'btn_info_v2',
            'balloon_pink', 'balloon_orange', 'balloon_bookmark', 'base_img_w', 'scrollarea_blue', 'btn_episode_category',
            'btn_episode_category_selected', 'icon_search', 'btn_orange_reduced', 'icon_shiori', 'icon_download',
            'icon_trash', 'base_popup', 'sub_header', 'base_footer', 'main', 'base_list_empty', 'btn_movie_start',
            'btn_movie_stop', 'movie_seek_bar_base', 'movie_seek_bar_gauge', 'movie_seek_bar_slider', 'btn_close',
            'btn_cansel', 'icon_face_base', 'icon_face_frame', 'menu_button', 'OptionVolumeSmall', 'OptionVolumeBig',
            'OptionVolumeCursor']
TEXTURES += ['noimage_thumbnail']
# story effects: the soft-edged black wipe of adv_slidein/slideout_blur_* (9-slice, left cap 784px)
SPRITES.append('blur_left_black_mask_reduced')
EFFECT_BUNDLES = ['adv_slidein_blur_left.and']


def save_sprite(o, out, meta):
    d = o.read()
    if d.m_Name in SPRITES and d.m_Name not in meta:
        d.image.save(os.path.join(out, d.m_Name + '.png'))
        b = d.m_Border
        meta[d.m_Name] = {'size': list(d.image.size), 'border': [round(b.x), round(b.y), round(b.z), round(b.w)]}
        print(d.m_Name, meta[d.m_Name])


def main(apk):
    import UnityPy
    out = os.path.join(config.DATA_DIR, 'ui')
    os.makedirs(out, exist_ok=True)
    # UnityPy keeps files open, so tolerate cleanup failures of the scratch copy
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        with zipfile.ZipFile(apk) as z:
            for i in z.infolist():
                if i.filename.startswith('assets/bin/Data/') and '/Managed/' not in i.filename:
                    z.extract(i, tmp)
        env = UnityPy.load(os.path.join(tmp, 'assets', 'bin', 'Data'))
        meta = {}
        for o in env.objects:
            if o.type.name == 'Texture2D':
                d = o.read()
                if d.m_Name in TEXTURES and d.m_Name not in meta:
                    d.image.save(os.path.join(out, d.m_Name + '.png'))
                    meta[d.m_Name] = {'size': list(d.image.size), 'border': [0, 0, 0, 0]}
                    print(d.m_Name, meta[d.m_Name])
                continue
            if o.type.name != 'Sprite':
                continue
            save_sprite(o, out, meta)
        # the story effects' sprites live in their own bundles in the archive, not in the APK
        try:
            with open(os.path.join(config.DATA_DIR, 'assets.json'), encoding='utf8') as f:
                assets = json.load(f)
        except OSError:
            assets = {}
        for bundle in EFFECT_BUNDLES:
            p = os.path.join(config.DOWNLOAD_DIR, assets.get(bundle, bundle))
            if os.path.exists(p):
                with open(p, 'rb') as f:
                    blob = f.read()
                if not blob.startswith(b'UnityFS'):
                    blob = t7scrypt.decode_file(blob)
                for o in UnityPy.load(blob).objects:
                    if o.type.name == 'Sprite':
                        save_sprite(o, out, meta)
    with open(os.path.join(out, 'sprites.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    missing = [s for s in SPRITES + TEXTURES if s not in meta]
    if missing:
        print('not found:', missing)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else config.BASE_APK)
