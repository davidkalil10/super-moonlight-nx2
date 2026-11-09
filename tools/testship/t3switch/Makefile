CC ?= cc
CFLAGS ?= -O2
WARNINGS := -std=c11 -Wall -Wextra -Wpedantic -Wconversion -Wshadow -Werror
SOURCES := src/hidkbd_ffs.c src/typer.c src/command.c

ifeq ($(strip $(OUTPUT)),)
$(error Set OUTPUT to the controller executable in a fresh build directory)
endif

.PHONY: all
all: $(OUTPUT)

$(OUTPUT): $(SOURCES) $(wildcard src/*.h)
	$(CC) $(CFLAGS) $(WARNINGS) $(SOURCES) $(LDFLAGS) -o $@
