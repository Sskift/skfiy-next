#!/bin/bash
# A stand-in for the `claude` and `codex` CLIs (linked under either name) for
# scripts/test_install.sh: it records every call in $FAKE_CLI_DIR/<name>.log and
# keeps one "skfiy" MCP entry in $FAKE_CLI_DIR/<name>.entry, answering
# `mcp get/add/remove` the way the real CLIs do. It never touches real config.
set -u
name=$(basename "$0")
dir=${FAKE_CLI_DIR:?FAKE_CLI_DIR is not set}
entry="$dir/$name.entry"
printf '%s\n' "$*" >> "$dir/$name.log"

[ "${1:-}" = mcp ] || { echo "fake $name: only mcp is supported" >&2; exit 2; }
command=${2:-}
shift 2

case "$command" in
get)
    if [ ! -f "$entry" ]; then
        if [ "$name" = claude ]; then echo "No MCP server named \"skfiy\". Run \`claude mcp add\` to add one."; else echo "Error: No MCP server named 'skfiy' found." >&2; fi
        exit 1
    fi
    cmd=$(sed -n 's/^command=//p' "$entry")
    args=$(sed -n 's/^args=//p' "$entry")
    if [ "$name" = claude ]; then
        echo "skfiy:"
        echo "  Scope: User config (available in all your projects)"
        echo "  Status: ✓ Connected"
        echo "  Type: stdio"
        echo "  Command: $cmd"
        echo "  Args: $args"
        if grep -q '^env=' "$entry"; then
            echo "  Environment:"
            sed -n 's/^env=/    /p' "$entry"
        fi
        echo ""
        echo "To remove this server, run: claude mcp remove skfiy -s user"
    else
        env_json=$(sed -n 's/^env=\([^=]*\)=\(.*\)$/"\1":"\2"/p' "$entry" | paste -sd, -)
        args_json=$(printf '%s\n' $args | sed 's/.*/"&"/' | paste -sd, -)
        echo "{\"name\":\"skfiy\",\"enabled\":true,\"transport\":{\"type\":\"stdio\",\"command\":\"$cmd\",\"args\":[$args_json],\"env\":{$env_json},\"env_vars\":[],\"cwd\":null}}"
    fi
    ;;
add)
    envs=()
    server=""
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do
        case "$1" in
            --scope|-s) shift ;;
            -e|--env) envs+=("$2"); shift ;;
            *) server=$1 ;;
        esac
        shift
    done
    shift  # --
    [ "$server" = skfiy ] || { echo "fake $name: unexpected server name $server" >&2; exit 2; }
    if [ -f "$entry" ]; then echo "MCP server skfiy already exists in user config" >&2; exit 1; fi
    {
        echo "command=$1"
        shift
        echo "args=$*"
        for pair in ${envs[@]+"${envs[@]}"}; do echo "env=$pair"; done
    } > "$entry"
    echo "Added stdio MCP server skfiy"
    ;;
remove)
    [ -f "$entry" ] || { echo "No MCP server found with name: skfiy" >&2; exit 1; }
    rm -f "$entry"
    echo "Removed MCP server skfiy"
    ;;
*)
    echo "fake $name: mcp $command is not supported" >&2
    exit 2
    ;;
esac
