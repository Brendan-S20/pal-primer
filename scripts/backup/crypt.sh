#!/usr/bin/env bash
# Seal a dump directory into one encrypted file, or open one again.
#
#   BACKUP_PASSPHRASE=... scripts/backup/crypt.sh seal <dump-dir> <out.tar.gz.gpg>
#   BACKUP_PASSPHRASE=... scripts/backup/crypt.sh open <in.tar.gz.gpg> <out-dir>
#
# `open` without BACKUP_PASSPHRASE set asks for it at the terminal, which is
# the right way to run it by hand: the passphrase then never sits in shell
# history or in an environment a child process can read.
#
# ── THE FORMAT, SO IT CAN BE OPENED WITHOUT THIS SCRIPT ───────────────────
#
# A gzip'd tar of roles.sql, schema.sql, data.sql and counts.json, encrypted
# with OpenPGP symmetric encryption (AES-256, SHA-512 key derivation at the
# maximum iteration count). Any GnuPG opens it:
#
#   gpg --decrypt houndstack-db-....tar.gz.gpg | tar -xzf -
#
# gpg's own compression is turned off because the tar is already gzip'd;
# compressing twice costs time and gains nothing.
#
# ── THE PASSPHRASE IS THE BACKUP ──────────────────────────────────────────
#
# Lose it and every archive this workflow has made is random bytes. It lives
# in two places on purpose: the BACKUP_PASSPHRASE repository secret, which
# GitHub will never show anyone again, and the owner's password manager,
# which is the only copy a human can read. See docs/backups-and-restore.md.
#
# The length floor is not decoration. These files are downloadable by anyone
# with read access to the repository, for thirty days, and a symmetric archive
# can be attacked offline at whatever speed the attacker can afford. A short
# passphrase protects customer data from nobody.

set -euo pipefail

MIN_LEN=20

need_passphrase() {
  if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
    echo "::error::BACKUP_PASSPHRASE is not set."
    echo "  Add it at Settings -> Secrets and variables -> Actions -> New repository secret."
    echo "  Generate one with:  openssl rand -base64 32"
    echo "  and store the SAME value in your password manager first: GitHub never shows a"
    echo "  secret again, and a backup whose passphrase is lost cannot be opened by anyone."
    exit 1
  fi
  if [ "${#BACKUP_PASSPHRASE}" -lt "$MIN_LEN" ]; then
    echo "::error::BACKUP_PASSPHRASE is ${#BACKUP_PASSPHRASE} characters; it must be at least $MIN_LEN."
    echo "  The encrypted archives are downloadable by anyone with read access to the repo,"
    echo "  and a short passphrase can be guessed offline. openssl rand -base64 32 gives 44."
    exit 1
  fi
}

mode="${1:?usage: crypt.sh seal|open <in> <out>}"
in="${2:?usage: crypt.sh seal|open <in> <out>}"
out="${3:?usage: crypt.sh seal|open <in> <out>}"

case "$mode" in
  seal)
    need_passphrase
    for f in roles.sql schema.sql data.sql counts.json; do
      [ -s "$in/$f" ] || { echo "::error::$in/$f is missing or empty; refusing to seal a partial backup"; exit 1; }
    done
    # --passphrase-fd keeps the passphrase out of argv, where any process on
    # the machine could read it from the process table.
    tar -C "$in" -czf - roles.sql schema.sql data.sql counts.json \
      | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
          --symmetric --cipher-algo AES256 \
          --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 \
          --compress-algo none \
          --output "$out" 3<<<"$BACKUP_PASSPHRASE"
    # Prove the file opens with the passphrase it was sealed with, now, while
    # the plaintext still exists. Finding out at restore time is too late.
    listing="$(gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$out" 3<<<"$BACKUP_PASSPHRASE" \
      | tar -tzf - | sort | tr '\n' ' ')"
    if [ "$listing" != "counts.json data.sql roles.sql schema.sql " ]; then
      echo "::error::the sealed archive did not open again with the same passphrase (listing: '$listing')"
      exit 1
    fi
    echo "sealed and re-opened: $(basename "$out") ($(wc -c < "$out" | tr -d ' ') bytes)"
    ;;
  open)
    mkdir -p "$out"
    if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
      gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$in" 3<<<"$BACKUP_PASSPHRASE" \
        | tar -C "$out" -xzf -
    else
      gpg --decrypt "$in" | tar -C "$out" -xzf -
    fi
    for f in roles.sql schema.sql data.sql counts.json; do
      [ -s "$out/$f" ] || { echo "::error::$f is missing from the archive"; exit 1; }
    done
    echo "opened into $out"
    ;;
  *)
    echo "usage: crypt.sh seal|open <in> <out>"
    exit 2
    ;;
esac
