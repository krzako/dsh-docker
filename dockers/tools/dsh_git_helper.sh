#!/usr/bin/env bash
#
# Interactive branch helper for the Git repositories served by the dsh-git
# container. Runs on the host; every Git operation is executed inside the
# container through `docker compose exec`.
#
# Flow: the script lists the repositories found in the container (/repos),
# asks which one to work on, and only then shows the menu:
#
#   0) change repository (back to the repository list)
#   1) list branches
#   2) archive a branch (rename <name> to archive/<name>)
#   3) delete a branch
#   4) exit
#
# Repositories are listed as numbered entries (0. name, 1. ...) without
# their .git suffix; selecting one works by index or by name (repo or
# repo.git).
#
# The dsh-git container serves bare repositories from /repos (git-daemon
# base path), so a repository pushed as git://dsh-git/<name>.git lives at
# /repos/<name>.git. DSH_GIT_SERVICE overrides the compose service name
# (default dsh-git).
#
# Notes:
# - An invalid repository or branch name prints a message and asks again
#   (repository prompt) or returns to the option menu (branch prompts).
# - Deleting uses the safe `git branch -d`, so unmerged branches are refused.
# - The repository's HEAD branch is never deleted; in a bare repository Git
#   would otherwise remove it and leave HEAD dangling.
# - Changes made directly inside the container bypass the pre-receive hook
#   that guards pushes.

set -euo pipefail

# Git Bash on Windows (MSYS) rewrites arguments that look like POSIX paths
# (for example /repos) into Windows paths before the native docker.exe sees
# them, which breaks every container path below. Both variables disable that
# conversion; on Linux and macOS they are ordinary, harmless environment
# variables.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# Repo root: the compose files the scripts drive live there.
cd "$(dirname "$0")/.."

SERVICE="${DSH_GIT_SERVICE:-dsh-git}"
REPOS_BASE="/repos"

require_running_service() {
  if ! docker compose ps --status running --services 2>/dev/null | grep -Fxq "$SERVICE"; then
    echo "Error: service '$SERVICE' is not running. Start it first with: docker compose up -d" >&2
    exit 1
  fi
}

# Run one command inside the dsh-git container. The safe.directory override
# mirrors the daemon's own environment and avoids bind-mount ownership
# complaints from Git.
compose_exec() {
  docker compose exec -T \
    -e GIT_CONFIG_COUNT=1 \
    -e GIT_CONFIG_KEY_0=safe.directory \
    -e GIT_CONFIG_VALUE_0='*' \
    "$SERVICE" "$@"
}

# Run git against the selected repository inside the container.
git_cmd() {
  compose_exec git --git-dir "$REPO_IN_CONTAINER" "$@"
}

# Strip leading/trailing whitespace.
trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

branch_exists() {
  git_cmd show-ref --verify --quiet "refs/heads/$1"
}

head_branch() {
  git_cmd symbolic-ref --short -q HEAD || true
}

# Discover the bare repositories the container serves: direct children of
# /repos named *.git, sorted. Populates the repo_paths array (empty when
# none are found).
find_repositories() {
  local raw
  if ! raw="$(compose_exec find "$REPOS_BASE" -maxdepth 1 -mindepth 1 -type d -name '*.git' 2>/dev/null)"; then
    echo "Error: failed to list repositories in container '$SERVICE' (find $REPOS_BASE)." >&2
    exit 1
  fi
  mapfile -t repo_paths < <(printf '%s\n' "$raw" | grep -v '^$' | sort || true)
}

# Print the repositories found in the container and ask which one to work
# on. Sets REPO_IN_CONTAINER to the selected absolute path. The prompt
# repeats until the value matches a listed repository; with exactly one
# repository an empty input selects it.
pick_repository() {
  find_repositories
  if [[ ${#repo_paths[@]} -eq 0 ]]; then
    echo "Error: no repositories found in container '$SERVICE' under $REPOS_BASE." >&2
    echo "Add one first (dsh-git/add-to-dsh.sh) or check the volume mount." >&2
    exit 1
  fi

  local names=() path name
  for path in "${repo_paths[@]}"; do
    name="${path#"$REPOS_BASE/"}"
    names+=("${name%.git}")
  done

  echo "Available repositories:"
  local i
  for i in "${!names[@]}"; do
    echo "  $i. ${names[$i]}"
  done
  if [[ ${#names[@]} -eq 1 ]]; then
    echo "Press Enter without typing a value to select it."
  fi

  local choice needle i
  while true; do
    if ! read -r -p "Select the repository to work on: " choice; then
      echo "Error: no more input available." >&2
      exit 1
    fi
    choice="$(trim "$choice")"
    if [[ -z "$choice" && ${#names[@]} -eq 1 ]]; then
      REPO_IN_CONTAINER="${repo_paths[0]}"
      return 0
    fi
    # Accept a listing index, or the name with or without the .git suffix
    # and /repos prefix; the listing itself shows names without .git.
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( 10#$choice < ${#names[@]} )); then
      REPO_IN_CONTAINER="${repo_paths[$((10#$choice))]}"
      return 0
    fi
    needle="${choice#"$REPOS_BASE/"}"
    needle="${needle%.git}"
    for i in "${!names[@]}"; do
      if [[ "${names[$i]}" == "$needle" ]]; then
        REPO_IN_CONTAINER="${repo_paths[$i]}"
        return 0
      fi
    done
    echo "Invalid value, try again." >&2
  done
}

print_menu() {
  local current
  current="$(head_branch)"
  [[ -n "$current" ]] || current="(none)"
  echo ""
  echo "============================================================"
  echo " DSH Git helper"
  echo " Container:      $SERVICE"
  echo " Repository:     $REPO_IN_CONTAINER"
  echo " HEAD branch:    $current"
  echo "============================================================"
  echo " 0) Change repository"
  echo " 1) List branches"
  echo " 2) Archive branch (rename to archive/<name>)"
  echo " 3) Delete branch"
  echo " 4) Exit"
}

list_branches() {
  echo ""
  echo "Local branches:"
  git_cmd --no-pager branch --list
  local remotes
  remotes="$(git_cmd --no-pager branch -r --list || true)"
  if [[ -n "$remotes" ]]; then
    echo ""
    echo "Remote branches (information only; operations act on local branches):"
    printf '%s\n' "$remotes"
  fi
}

# Ask for a branch name and validate it against the repository's local
# branches. A valid name is echoed to stdout; problem messages go to stderr
# and the function returns 1, which sends the caller back to the menu.
prompt_branch() {
  local action="$1" name
  if ! read -r -p "Enter the name of the branch to $action: " name; then
    echo "Error: no more input available." >&2
    exit 1
  fi
  name="$(trim "$name")"
  if [[ -z "$name" ]]; then
    echo "No branch name entered." >&2
    return 1
  fi
  if ! branch_exists "$name"; then
    echo "Invalid branch '$name'." >&2
    return 1
  fi
  printf '%s\n' "$name"
}

archive_branch() {
  local branch target head
  if ! branch="$(prompt_branch archive)"; then
    return 0
  fi
  target="archive/$branch"
  if branch_exists "$target"; then
    echo "Branch '$target' already exists; nothing was renamed." >&2
    return 0
  fi
  head="$(head_branch)"
  if git_cmd branch -m "$branch" "$target"; then
    echo "Branch '$branch' archived as '$target'."
    if [[ -n "$head" && "$branch" == "$head" ]]; then
      echo "Note: '$branch' was the repository's HEAD branch; HEAD now points to '$target'."
    fi
  else
    echo "Failed to rename branch '$branch' to '$target'." >&2
  fi
}

delete_branch() {
  local branch head
  if ! branch="$(prompt_branch delete)"; then
    return 0
  fi
  head="$(head_branch)"
  if [[ -n "$head" && "$branch" == "$head" ]]; then
    echo "Branch '$branch' is the repository's HEAD branch; refusing to delete it." >&2
    return 0
  fi
  if git_cmd branch -d "$branch"; then
    echo "Branch '$branch' deleted."
  else
    echo "Branch '$branch' was not deleted (see the Git message above)." >&2
  fi
}

require_running_service

# Ask which repository to work on before showing the menu.
pick_repository

# Sanity check: the selected repository must be a usable Git repository.
if ! repo_probe="$(git_cmd rev-parse --git-dir 2>&1)"; then
  echo "Error: cannot access repository '$REPO_IN_CONTAINER' in container '$SERVICE':" >&2
  printf '  %s\n' "$repo_probe" >&2
  exit 1
fi

while true; do
  print_menu
  if ! read -r -p "Select an option [0-4]: " choice; then
    echo ""
    echo "No more input; exiting."
    exit 0
  fi
  choice="$(trim "$choice")"
  case "$choice" in
    0) pick_repository ;;
    1) list_branches ;;
    2) archive_branch ;;
    3) delete_branch ;;
    4)
      echo "Bye."
      exit 0
      ;;
    *)
      echo "Invalid option, try again." >&2
      ;;
  esac
done
