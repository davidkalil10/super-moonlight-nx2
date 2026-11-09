.DEFAULT_GOAL := all
.SUFFIXES:

CHECK_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
LIBNX2_DIR := $(CHECK_DIR)/libnx2

ifeq ($(strip $(DEVKITPRO)),)
$(error Set DEVKITPRO to the devkitPro installation containing libounce)
endif
ifeq ($(strip $(BUILD_DIR)),)
$(error Set BUILD_DIR to a new directory under /media/storage2/builds/moonlight)
endif

include $(DEVKITPRO)/libounce/switch2_rules

OUTPUT := $(BUILD_DIR)/moonlight-nx2-libnx2-check
OBJECTS := $(BUILD_DIR)/main.o $(BUILD_DIR)/scan.o $(BUILD_DIR)/inspect.o $(BUILD_DIR)/module.o
ARCH := -march=armv8-a+crc+crypto -mtune=cortex-a57 -mtp=soft -fPIE
CFLAGS := $(ARCH) -std=gnu11 -O2 -g -Wall -Wextra -Werror -ffunction-sections -fdata-sections
LDFLAGS := $(ARCH) -specs=$(LIBNX)/switch.specs -Wl,--export-dynamic-symbol=libnx2CheckAnchor
LDFLAGS += -Wl,-Map,$(OUTPUT).map
LIBS := -L$(LIBNX)/lib -lnx

.PHONY: all
all: $(OUTPUT).nro

$(BUILD_DIR)/main.o: $(CHECK_DIR)/main.c
	$(CC) $(CPPFLAGS) -I$(LIBNX)/include $(CFLAGS) -MMD -MP -c $< -o $@

$(BUILD_DIR)/scan.o: $(CHECK_DIR)/scan.c
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

$(BUILD_DIR)/inspect.o: $(CHECK_DIR)/inspect.c
	$(CC) -I$(LIBNX2_DIR)/include/libnx2 $(CFLAGS) -MMD -MP -c $< -o $@

$(BUILD_DIR)/module.o: $(LIBNX2_DIR)/src/runtime/module.c
	$(CC) -I$(LIBNX2_DIR)/include/libnx2 $(CFLAGS) -MMD -MP -c $< -o $@

$(OUTPUT).elf: $(OBJECTS)
	$(CC) $(LDFLAGS) $(OBJECTS) $(LIBS) -o $@

$(OUTPUT).nacp:
	nacptool --create "Moonlight NX2 libnx2 check" "Azkali" "0.1.0" $@

$(OUTPUT).nro: $(OUTPUT).elf $(OUTPUT).nacp
	elf2nro $< $@ --nacp=$(OUTPUT).nacp

-include $(OBJECTS:.o=.d)
