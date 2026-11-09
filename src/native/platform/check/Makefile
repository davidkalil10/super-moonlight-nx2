.DEFAULT_GOAL := all
.SUFFIXES:

CHECK_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PLATFORM_DIR := $(abspath $(CHECK_DIR)/..)

ifeq ($(strip $(DEVKITPRO)),)
$(error Set DEVKITPRO to the devkitPro installation containing libounce)
endif
ifeq ($(strip $(BUILD_DIR)),)
$(error Set BUILD_DIR to a new directory under /media/storage2/builds/moonlight)
endif

include $(DEVKITPRO)/libounce/switch2_rules

OUTPUT := $(BUILD_DIR)/moonlight-nx2-gsv-frame-check
SOURCES := $(CHECK_DIR)/main.c $(PLATFORM_DIR)/gsv-frame.c
OBJECTS := $(addprefix $(BUILD_DIR)/,$(notdir $(SOURCES:.c=.o)))
ARCH := -march=armv8-a+crc+crypto -mtune=cortex-a57 -mtp=soft -fPIE
CPPFLAGS += -I$(LIBNX)/include -I$(DEVKITPRO)/portlibs/switch2/include
CFLAGS := $(ARCH) -std=gnu11 -O2 -g -Wall -Wextra -Werror -ffunction-sections -fdata-sections
WRAP := -Wl,--wrap=gsvRegisterFrame
FORCE := -Wl,--undefined=nvkmd_nvgpu_native_runtime_open -Wl,--undefined=cpuwinOpen
LDFLAGS := $(ARCH) -specs=$(LIBNX)/switch.specs -Wl,-Map,$(OUTPUT).map $(WRAP) $(FORCE)
LIBS := -L$(DEVKITPRO)/portlibs/switch2/lib -L$(LIBNX)/lib -lvulkan -lnx -lm

vpath %.c $(CHECK_DIR) $(PLATFORM_DIR)

.PHONY: all
all: $(OUTPUT).elf

$(BUILD_DIR)/%.o: %.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(OUTPUT).elf: $(OBJECTS)
	$(CC) $(LDFLAGS) $(OBJECTS) $(LIBS) -o $@

-include $(OBJECTS:.o=.d)
