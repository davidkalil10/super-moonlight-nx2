.DEFAULT_GOAL := all
.SUFFIXES:

UI_DIAGNOSTIC_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
UI_DIR := $(abspath $(UI_DIAGNOSTIC_DIR)/..)
RENDERER_DIR := $(abspath $(UI_DIR)/../renderer)
ATLAS := $(abspath $(UI_DIR)/../../streamer/ui/fonts/glyphs.bin)

ifeq ($(strip $(DEVKITPRO)),)
$(error Set DEVKITPRO to the devkitPro installation containing libounce)
endif
ifeq ($(strip $(BUILD_DIR)),)
$(error Set BUILD_DIR to a new directory under /media/storage2/builds/moonlight)
endif

include $(DEVKITPRO)/libounce/switch2_rules

OUTPUT := $(BUILD_DIR)/moonlight-nx2-ui-diagnostic
UI_SOURCES := $(wildcard $(UI_DIR)/*.c)
SOURCES := $(UI_DIAGNOSTIC_DIR)/main.c $(UI_SOURCES) $(RENDERER_DIR)/renderer.c $(RENDERER_DIR)/frame.c \
	$(RENDERER_DIR)/surface.c
OBJECTS := $(addprefix $(BUILD_DIR)/,$(notdir $(SOURCES:.c=.o))) $(BUILD_DIR)/glyphs_bin.o
ARCH := -march=armv8-a+crc+crypto -mtune=cortex-a57 -mtp=soft -fPIE
CPPFLAGS += -I$(LIBNX)/include -I$(DEVKITPRO)/portlibs/switch2/include -I$(BUILD_DIR)
CFLAGS := $(ARCH) -std=gnu11 -O2 -g -Wall -Wextra -Werror -ffunction-sections -fdata-sections
LDFLAGS := $(ARCH) -specs=$(LIBNX)/switch.specs -Wl,-Map,$(OUTPUT).map
LIBS := -L$(DEVKITPRO)/portlibs/switch2/lib -L$(LIBNX)/lib -lvulkan -lnx -lm

vpath %.c $(UI_DIAGNOSTIC_DIR) $(UI_DIR) $(RENDERER_DIR)

.PHONY: all
all: $(OUTPUT).nro

$(BUILD_DIR)/glyphs_bin.s $(BUILD_DIR)/glyphs_bin.h: $(ATLAS)
	cp $< $(BUILD_DIR)/glyphs.bin
	cd $(BUILD_DIR) && bin2s -a 8 -H glyphs_bin.h glyphs.bin > glyphs_bin.s

$(BUILD_DIR)/glyphs_bin.o: $(BUILD_DIR)/glyphs_bin.s
	$(CC) $(ARCH) -x assembler-with-cpp -c $< -o $@

$(BUILD_DIR)/main.o: $(BUILD_DIR)/glyphs_bin.h

$(BUILD_DIR)/%.o: %.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(OUTPUT).elf: $(OBJECTS)
	$(CC) $(LDFLAGS) $(OBJECTS) $(LIBS) -o $@

$(OUTPUT).nacp:
	nacptool --create "Moonlight NX2 UI diagnostic" "Azkali" "0.1.0" $@

$(OUTPUT).nro: $(OUTPUT).elf $(OUTPUT).nacp
	elf2nro $< $@ --nacp=$(OUTPUT).nacp

-include $(OBJECTS:.o=.d)
