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
NACP_TITLE ?= Moonlight NX2 Rust core
ARCH := -march=armv8-a+crc+crypto -mtune=cortex-a57 -mtp=soft -fPIE
CPPFLAGS += -I$(LIBNX)/include
CFLAGS := $(ARCH) -std=gnu11 -O2 -g -Wall -Wextra -Werror -ffunction-sections -fdata-sections
LDFLAGS := $(ARCH) -specs=$(LIBNX)/switch.specs -Wl,-Map,$(OUTPUT).map -Wl,--wrap=gsvRegisterFrame
LIBS := -L$(DEVKITPRO)/portlibs/switch2/lib -L$(LIBNX)/lib -lvulkan -lnx -lm
OBJECTS := $(BUILD_DIR)/platform.o $(BUILD_DIR)/io_adapter.o

ifeq ($(SDK_BACKING),1)
ifeq ($(strip $(SDK_BACKING_LIBRARY_DIR)),)
$(error SDK_BACKING_LIBRARY_DIR must name the qualified alias archive directory)
endif
OBJECTS += $(BUILD_DIR)/sdk_backing.o
LIBS := -L$(SDK_BACKING_LIBRARY_DIR) $(LIBS)
endif

.PHONY: all
all: $(OUTPUT).nro

$(BUILD_DIR)/platform.o: $(SOURCE_DIR)/platform.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(BUILD_DIR)/io_adapter.o: $(SOURCE_DIR)/io_adapter.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(BUILD_DIR)/sdk_backing.o: $(SOURCE_DIR)/sdk_backing.c $(SOURCE_DIR)/sdk_backing.h
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(OUTPUT).elf: $(OBJECTS) $(RUST_LIBRARY)
	$(CC) $(LDFLAGS) $(OBJECTS) $(RUST_LIBRARY) $(LIBS) -o $@

$(OUTPUT).nacp:
	nacptool --create "$(NACP_TITLE)" "Azkali" "0.1.0" $@

$(OUTPUT).nro: $(OUTPUT).elf $(OUTPUT).nacp
	elf2nro $< $@ --nacp=$(OUTPUT).nacp

-include $(BUILD_DIR)/platform.d
-include $(BUILD_DIR)/io_adapter.d
-include $(BUILD_DIR)/sdk_backing.d
