# All targets delegate to scripts/tasks.py so behaviour is identical on Windows (no make) and Unix.
PY ?= python3

.PHONY: setup dev test demo reset build
setup: ; $(PY) scripts/tasks.py setup
dev:   ; $(PY) scripts/tasks.py dev
test:  ; $(PY) scripts/tasks.py test
demo:  ; $(PY) scripts/tasks.py demo
reset: ; $(PY) scripts/tasks.py reset
build: ; $(PY) scripts/tasks.py build
