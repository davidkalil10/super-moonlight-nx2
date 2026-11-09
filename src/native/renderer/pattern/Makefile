.DEFAULT_GOAL := all
.SUFFIXES:

PATTERN_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
RENDERER_DIR := $(abspath $(PATTERN_DIR)/..)

ifeq ($(strip $(DEVKITPRO)),)
$(error Set DEVKITPRO to the devkitPro installation containing libounce)
endif
ifeq ($(strip $(BUILD_DIR)),)
$(error Set BUILD_DIR to a new directory under /media/storage2/builds/moonlight)
endif

include $(DEVKITPRO)/libounce/switch2_rules

OUTPUT := $(BUILD_DIR)/moonlight-nx2-renderer-diagnostic
SOURCES := $(PATTERN_DIR)/main.c $(RENDERER_DIR)/renderer.c $(RENDERER_DIR)/frame.c $(RENDERER_DIR)/surface.c
OBJECTS := $(addprefix $(BUILD_DIR)/,$(notdir $(SOURCES:.c=.o)))
ARCH := -march=armv8-a+crc+crypto -mtune=cortex-a57 -mtp=soft -fPIE
CPPFLAGS += -I$(LIBNX)/include -I$(DEVKITPRO)/portlibs/switch2/include
CFLAGS := $(ARCH) -std=gnu11 -O2 -g -Wall -Wextra -Werror -ffunction-sections -fdata-sections
LDFLAGS := $(ARCH) -specs=$(LIBNX)/switch.specs -Wl,-Map,$(OUTPUT).map
LIBS := -L$(DEVKITPRO)/portlibs/switch2/lib -L$(LIBNX)/lib -lvulkan -lnx -lm

vpath %.c $(PATTERN_DIR) $(RENDERER_DIR)

.PHONY: all
all: $(OUTPUT).nro

$(BUILD_DIR)/%.o: %.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(OUTPUT).elf: $(OBJECTS)
	$(CC) $(LDFLAGS) $(OBJECTS) $(LIBS) -o $@

$(OUTPUT).nacp:
	nacptool --create "Moonlight NX2 renderer diagnostic" "Azkali" "0.1.0" $@

$(OUTPUT).nro: $(OUTPUT).elf $(OUTPUT).nacp
	elf2nro $< $@ --nacp=$(OUTPUT).nacp

-include $(OBJECTS:.o=.d)
