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
NACP_VERSION ?= 0.1.0
ICON_PATH ?= $(SOURCE_DIR)/icon.png
ARCH := -march=armv8-a+crc+crypto -mtune=cortex-a57 -mtp=soft -fPIE
CPPFLAGS += -I$(LIBNX)/include
CFLAGS := $(ARCH) -std=gnu11 -O2 -g -Wall -Wextra -Werror -ffunction-sections -fdata-sections
LDFLAGS := $(ARCH) -specs=$(LIBNX)/switch.specs -Wl,-Map,$(OUTPUT).map -Wl,--wrap=gsvRegisterFrame
LIBS := -L$(DEVKITPRO)/portlibs/switch2/lib -L$(LIBNX)/lib -lvulkan -lnx -lm
OBJECTS := $(BUILD_DIR)/platform.o $(BUILD_DIR)/io_adapter.o

ifeq ($(SDK_BACKING),1)
SDK_INTEROP_TOOLS := $(abspath $(SOURCE_DIR)/../../../tools/testship/sdk-interop)
SDK_BACKING_LIBRARY_DIR ?= $(BUILD_DIR)/sdk-interop/alias
ifeq ($(strip $(SDK_BACKING_LIBRARY_DIR)),)
$(error SDK_BACKING_LIBRARY_DIR must name an alias archive directory)
endif
SDK_BACKING_ARCHIVE := $(SDK_BACKING_LIBRARY_DIR)/libouncevk.a
OBJECTS += $(BUILD_DIR)/sdk_backing.o
LIBS := -L"$(SDK_BACKING_LIBRARY_DIR)" $(LIBS)

$(SDK_BACKING_ARCHIVE):
	sh "$(SDK_INTEROP_TOOLS)/prepare-alias-archive.sh" --devkitpro "$(DEVKITPRO)" --out "$(SDK_BACKING_LIBRARY_DIR)"

$(OUTPUT).elf: $(SDK_BACKING_ARCHIVE)

.PHONY: sdk-backing-verify
sdk-backing-verify: $(OUTPUT).elf
ifeq ($(NATIVE_DECODE),1)
	python3 -B $(SDK_INTEROP_TOOLS)/verify-final-elf.py \
		--tool-prefix $(DEVKITPRO)/devkitA64/bin/aarch64-none-elf \
		--sdk-archive $(DEVKITPRO)/portlibs/switch2/lib/libouncevk.a \
		--alias-archive $(SDK_BACKING_ARCHIVE) --map $(OUTPUT).map \
		--elf $(OUTPUT).elf $(BUILD_DIR)/sdk_backing.o $(BUILD_DIR)/native_owner.o > $(BUILD_DIR)/native-owner-link.log 2>&1; \
		status=$$?; printf '%s\n' "$$status" > $(BUILD_DIR)/native-owner-link.status; test "$$status" -eq 1
	python3 -B $(SOURCE_DIR)/../../../tools/testship/decode-bridge/check_link.py \
		--owner-caller moonlightNativeOwnerCall --log $(BUILD_DIR)/native-owner-link.log \
		--status-file $(BUILD_DIR)/native-owner-link.status
else
	python3 -B $(SDK_INTEROP_TOOLS)/verify-final-elf.py \
		--tool-prefix $(DEVKITPRO)/devkitA64/bin/aarch64-none-elf \
		--sdk-archive $(DEVKITPRO)/portlibs/switch2/lib/libouncevk.a \
		--alias-archive $(SDK_BACKING_ARCHIVE) --map $(OUTPUT).map \
		--elf $(OUTPUT).elf $(BUILD_DIR)/sdk_backing.o > $(BUILD_DIR)/sdk-backing-verify.log 2>&1 \
		|| { cat $(BUILD_DIR)/sdk-backing-verify.log; exit 1; }
endif

$(OUTPUT).nro: sdk-backing-verify
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
	nacptool --create "$(NACP_TITLE)" "Azkali" "$(NACP_VERSION)" $@

$(OUTPUT).nro: $(OUTPUT).elf $(OUTPUT).nacp $(ICON_PATH)
	elf2nro $< $@ --nacp=$(OUTPUT).nacp --icon="$(ICON_PATH)"

-include $(BUILD_DIR)/platform.d
-include $(BUILD_DIR)/io_adapter.d
-include $(BUILD_DIR)/sdk_backing.d

ifeq ($(NATIVE_DECODE),1)
OBJECTS += $(BUILD_DIR)/native_owner.o
OBJECTS += $(BUILD_DIR)/breadcrumb.o
LDFLAGS += -Wl,--wrap=moonlightPlatformLog
$(OUTPUT).elf: $(BUILD_DIR)/native_owner.o
$(OUTPUT).elf: $(BUILD_DIR)/breadcrumb.o
$(BUILD_DIR)/native_owner.o: $(SOURCE_DIR)/native_owner.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@
$(BUILD_DIR)/breadcrumb.o: $(SOURCE_DIR)/breadcrumb.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@
endif
