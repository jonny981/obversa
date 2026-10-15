# Records the graceful signal before it exits, so the test can tell a stop
# that gave it grace from one that forced it first. A shell sets its trap in
# its first milliseconds, where a Node helper can still be starting when
# teardown's first pass finds it and signals it.
dir=$1
trap 'printf "{\"pid\":%s}" "$$" > "$dir/helper-sigterm.json.tmp" && mv "$dir/helper-sigterm.json.tmp" "$dir/helper-sigterm.json"; exit 0' TERM
while :; do sleep 0.05; done
