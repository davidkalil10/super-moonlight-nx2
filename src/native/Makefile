.DEFAULT_GOAL := all
.SUFFIXES:

SOURCE_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

ifeq ($(strip $(DEVKITPRO)),)
$(error Set DEVKITPRO to the devkitPro installation containing libounce)
endif
ifeq ($(strip $(BUILD_DIR)),)
$(error Set BUILD_DIR to a new directory under /media/storage2/builds/moonlight)
endif

include $(DEVKITPRO)/libounce/switch2_rules

OUTPUT := $(BUILD_DIR)/moonlight-nx2-compat
OBJECTS := $(BUILD_DIR)/main.o $(BUILD_DIR)/input.o $(BUILD_DIR)/vulkan.o
OBJECTS += $(BUILD_DIR)/renderer/renderer.o $(BUILD_DIR)/renderer/frame.o $(BUILD_DIR)/renderer/surface.o
OBJECTS += $(BUILD_DIR)/audio/audio.o $(BUILD_DIR)/audio/queue.o $(BUILD_DIR)/audio/audout.o
OBJECTS += $(BUILD_DIR)/media/parser.o $(BUILD_DIR)/media/channel.o
OBJECTS += $(addprefix $(BUILD_DIR)/ui/,settings.o json.o store.o model.o page.o composer.o glyphs.o inflate.o uppercase.o bridge.o badge.o)
OBJECTS += $(BUILD_DIR)/platform/gsv-frame.o
OBJECTS += $(BUILD_DIR)/control/wire.o
ARCH := -march=armv8-a+crc+crypto -mtune=cortex-a57 -mtp=soft -fPIE
CPPFLAGS += -I$(LIBNX)/include -I$(DEVKITPRO)/portlibs/switch2/include -I$(BUILD_DIR) -I$(SOURCE_DIR)
CFLAGS := $(ARCH) -std=gnu11 -O2 -g -Wall -Wextra -Werror -ffunction-sections -fdata-sections
LDFLAGS := $(ARCH) -specs=$(LIBNX)/switch.specs -Wl,-Map,$(OUTPUT).map
LDFLAGS += -Wl,--wrap=gsvRegisterFrame
LIBS := -L$(DEVKITPRO)/portlibs/switch2/lib -L$(LIBNX)/lib -lvulkan -lnx -lm

.PHONY: all
all: $(OUTPUT).nro

$(BUILD_DIR)/%.o: $(SOURCE_DIR)/%.c $(SOURCE_DIR)/native.h $(SOURCE_DIR)/renderer.h $(wildcard $(SOURCE_DIR)/renderer/*.h) $(BUILD_DIR)/build-info.h
	@mkdir -p $(dir $@)
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(OUTPUT).elf: $(OBJECTS)
	$(CC) $(LDFLAGS) $(OBJECTS) $(LIBS) -o $@

$(OUTPUT).nacp:
	nacptool --create "Moonlight NX2 compatibility" "Azkali" "0.1.0" $@

$(OUTPUT).nro: $(OUTPUT).elf $(OUTPUT).nacp
	elf2nro $< $@ --nacp=$(OUTPUT).nacp

-include $(OBJECTS:.o=.d)
