.DEFAULT_GOAL := all
.SUFFIXES:

CHECK_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
MEDIA_DIR := $(abspath $(CHECK_DIR)/..)

ifeq ($(strip $(DEVKITPRO)),)
$(error Set DEVKITPRO to the devkitPro installation containing libounce)
endif
ifeq ($(strip $(BUILD_DIR)),)
$(error Set BUILD_DIR to a new directory under /media/storage2/builds/moonlight)
endif

include $(DEVKITPRO)/libounce/switch2_rules

OUTPUT := $(BUILD_DIR)/moonlight-nx2-media-check
SOURCES := $(CHECK_DIR)/main.c $(MEDIA_DIR)/parser.c $(MEDIA_DIR)/channel.c
OBJECTS := $(addprefix $(BUILD_DIR)/,$(notdir $(SOURCES:.c=.o)))
ARCH := -march=armv8-a+crc+crypto -mtune=cortex-a57 -mtp=soft -fPIE
CPPFLAGS += -I$(LIBNX)/include
CFLAGS := $(ARCH) -std=gnu11 -O2 -g -Wall -Wextra -Werror -ffunction-sections -fdata-sections
LDFLAGS := $(ARCH) -specs=$(LIBNX)/switch.specs -Wl,-Map,$(OUTPUT).map
LIBS := -L$(LIBNX)/lib -lnx

vpath %.c $(CHECK_DIR) $(MEDIA_DIR)

.PHONY: all
all: $(OUTPUT).elf

$(BUILD_DIR)/%.o: %.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(OUTPUT).elf: $(OBJECTS)
	$(CC) $(LDFLAGS) $(OBJECTS) $(LIBS) -o $@

-include $(OBJECTS:.o=.d)
