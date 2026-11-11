.DEFAULT_GOAL := all
.SUFFIXES:
SOURCE_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

ifeq ($(strip $(DEVKITPRO)),)
$(error Set DEVKITPRO to the pinned Switch 2 SDK)
endif
ifeq ($(strip $(BUILD_DIR)),)
$(error Set BUILD_DIR to an external output directory)
endif
ifeq ($(strip $(RUST_LIBRARY)),)
$(error Set RUST_LIBRARY to the completed PIC runtime archive)
endif

include $(DEVKITPRO)/libounce/switch2_rules

OUTPUT := $(BUILD_DIR)/moonlight-nx2-rust
NACP_TITLE ?= Moonlight NX2
NACP_VERSION ?= 0.1.0
ICON_PATH ?= $(SOURCE_DIR)/icon.jpg
ARCH := -march=armv8-a+crc+crypto -mtune=cortex-a57 -mtp=soft -fPIE
CPPFLAGS += -I$(LIBNX)/include
CFLAGS := $(ARCH) -std=gnu11 -O2 -g -Wall -Wextra -Werror -ffunction-sections -fdata-sections
LDFLAGS := $(ARCH) -specs=$(LIBNX)/switch.specs -Wl,-Map,$(OUTPUT).map -Wl,--wrap=gsvRegisterFrame
MIMALLOC ?= 1
NX_LIBRARY := $(if $(filter 0,$(MIMALLOC)),-lounce_core,-lnx)
LIBS := -L$(DEVKITPRO)/portlibs/switch2/lib -L$(LIBNX)/lib -lvulkan $(NX_LIBRARY) -lm
OBJECTS := $(BUILD_DIR)/platform.o $(BUILD_DIR)/io_adapter.o $(BUILD_DIR)/system.o $(BUILD_DIR)/sdk_viddec.o \
           $(BUILD_DIR)/sdk_decoder.o $(BUILD_DIR)/clocks.o

.PHONY: all
all: $(OUTPUT).nro

$(BUILD_DIR)/platform.o: $(SOURCE_DIR)/platform.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(BUILD_DIR)/io_adapter.o: $(SOURCE_DIR)/io_adapter.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(BUILD_DIR)/system.o: $(SOURCE_DIR)/system.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(BUILD_DIR)/sdk_viddec.o: $(SOURCE_DIR)/sdk_viddec.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(BUILD_DIR)/sdk_decoder.o: $(SOURCE_DIR)/sdk_decoder.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(BUILD_DIR)/clocks.o: $(SOURCE_DIR)/clocks.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(OUTPUT).elf: $(OBJECTS) $(RUST_LIBRARY)
	$(CC) $(LDFLAGS) $(OBJECTS) $(RUST_LIBRARY) $(LIBS) -o $@

$(OUTPUT).nacp:
	nacptool --create "$(NACP_TITLE)" "Azkali" "$(NACP_VERSION)" $@

$(OUTPUT).nro: $(OUTPUT).elf $(OUTPUT).nacp $(ICON_PATH)
	elf2nro $< $@ --nacp=$(OUTPUT).nacp --icon="$(ICON_PATH)"

-include $(BUILD_DIR)/platform.d
-include $(BUILD_DIR)/io_adapter.d
-include $(BUILD_DIR)/system.d
-include $(BUILD_DIR)/sdk_viddec.d
-include $(BUILD_DIR)/sdk_decoder.d
-include $(BUILD_DIR)/clocks.d

ifeq ($(BREADCRUMBS),1)
OBJECTS += $(BUILD_DIR)/breadcrumb.o
LDFLAGS += -Wl,--wrap=moonlightPlatformLog
$(OUTPUT).elf: $(BUILD_DIR)/breadcrumb.o
$(BUILD_DIR)/breadcrumb.o: $(SOURCE_DIR)/breadcrumb.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@
endif
