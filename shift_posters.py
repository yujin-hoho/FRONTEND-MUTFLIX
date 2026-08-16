import argparse
import os
import sys

# ==============================================================================
# DEFAULT CONFIGURATION
# Bisa diubah langsung di sini atau lewat argumen CLI terminal
# ==============================================================================
DEFAULT_TARGET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage", "posters", "movies")
DEFAULT_MISSING_IDS = [67]  # Masukkan 5 ID yang bolong di sini, contoh: [67, 120, 205, 310, 450]
DEFAULT_DRY_RUN = True       # True = simulasi cek log, False = langsung eksekusi rename
# ==============================================================================


def shift_folders(target_dir, missing_ids, dry_run=True):
    if not os.path.exists(target_dir):
        # Coba fallback ke folder 'posters' jika 'storage/posters' tidak ada
        alt_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "posters", "movies")
        if os.path.exists(alt_dir):
            target_dir = alt_dir
        else:
            print(f"[ERROR] Folder target tidak ditemukan: {target_dir}")
            return

    if not missing_ids:
        print("[ERROR] Daftar MISSING_IDS masih kosong! Masukkan minimal 1 ID yang bolong.")
        return

    print("=" * 70)
    print(f"TARGET DIRECTORY : {os.path.abspath(target_dir)}")
    print(f"MISSING IDS      : {sorted(missing_ids)}")
    print(f"MODE             : {'[DRY RUN - SIMULASI]' if dry_run else '[LIVE EXECUTION - RENAME NYATA]'}")
    print("=" * 70)

    # Urutkan missing IDs dari BESAR ke KECIL agar pergeseran tidak saling menimpa
    sorted_missing = sorted(missing_ids, reverse=True)

    for missing_id in sorted_missing:
        print(f"\n---> Memproses pergeseran untuk slot kosong ID: {missing_id}")

        # Ambil semua subfolder yang namanya angka murni
        subfolders = []
        for entry in os.scandir(target_dir):
            if entry.is_dir() and entry.name.isdigit():
                subfolders.append(int(entry.name))

        # Filter folder yang nomornya >= missing_id, lalu urutkan dari TERBESAR mundur ke KECIL
        to_shift = sorted([f_id for f_id in subfolders if f_id >= missing_id], reverse=True)

        if not to_shift:
            print(f"  [INFO] Tidak ada folder bernomor >= {missing_id}")
            continue

        print(f"  Ditemukan {len(to_shift)} folder yang akan digeser +1 (mulai dari {to_shift[0]} mundur ke {to_shift[-1]}).")

        for current_id in to_shift:
            new_id = current_id + 1
            src_path = os.path.join(target_dir, str(current_id))
            dst_path = os.path.join(target_dir, str(new_id))

            if os.path.exists(dst_path) and not dry_run:
                print(f"  [WARNING] Target folder sudah ada: {dst_path}. Dilewati untuk keamanan.")
                continue

            if dry_run:
                print(f"  [SIMULASI] Rename: folder '{current_id}' -> '{new_id}'")
            else:
                try:
                    os.rename(src_path, dst_path)
                    print(f"  [OK] Renamed: '{current_id}' -> '{new_id}'")
                except Exception as e:
                    print(f"  [GAGAL] Gagal rename '{current_id}': {e}")

        print(f"  -> Slot ID {missing_id} sekarang sudah KOSONG & tersinkron.")

    print("\n" + "=" * 70)
    if dry_run:
        print("SIMULASI SELESAI. Jika output sudah benar, jalankan dengan argumen --run atau ubah DEFAULT_DRY_RUN = False.")
    else:
        print("SEMUA FOLDER BERHASIL DIGESER & TERSINKRON DENGAN ID ASLI!")
    print("=" * 70)


def main():
    parser = argparse.ArgumentParser(description="Shift and re-align poster folders by missing ID index.")
    parser.add_argument("--dir", "-d", type=str, default=DEFAULT_TARGET_DIR, help="Path ke folder posters/backdrops (misal: storage/posters/movies)")
    parser.add_argument("--missing", "-m", type=str, default=None, help="Daftar ID yang bolong dipisah koma (contoh: 67,120,205)")
    parser.add_argument("--run", action="store_true", help="Eksekusi rename secara nyata (bukan simulasi)")

    args = parser.parse_args()

    target_dir = args.dir
    missing_ids = DEFAULT_MISSING_IDS
    if args.missing:
        try:
            missing_ids = [int(x.strip()) for x in args.missing.split(",") if x.strip().isdigit()]
        except Exception:
            print("[ERROR] Format --missing salah. Contoh yang benar: --missing 67,120,205")
            sys.exit(1)

    dry_run = not args.run if args.run else DEFAULT_DRY_RUN

    shift_folders(target_dir, missing_ids, dry_run=dry_run)


if __name__ == "__main__":
    main()
