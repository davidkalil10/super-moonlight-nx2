#include <stdlib.h>
#include <string.h>

#include <vulkan/vulkan.h>

#include "native.h"

static bool device_extensions(VkPhysicalDevice device)
{
    for (unsigned attempt = 0; attempt < 3; attempt++) {
        uint32_t count = 0;
        VkResult rc = vkEnumerateDeviceExtensionProperties(device, NULL, &count, NULL);
        if (rc != VK_SUCCESS || count > 4096) {
            moonlightReport("vulkan.extensions: count failed (%d, %u)", rc, count);
            return false;
        }

        VkExtensionProperties *extensions = calloc(count ? count : 1, sizeof(*extensions));
        if (!extensions) {
            moonlightReport("vulkan.extensions: allocation failed");
            return false;
        }
        rc = vkEnumerateDeviceExtensionProperties(device, NULL, &count, extensions);
        if (rc == VK_INCOMPLETE) {
            free(extensions);
            continue;
        }
        if (rc != VK_SUCCESS) {
            moonlightReport("vulkan.extensions: enumeration failed (%d)", rc);
            free(extensions);
            return false;
        }

        bool video_queue = false;
        bool h264 = false;
        bool av1 = false;
        bool video_decode = false;
        for (uint32_t i = 0; i < count; i++) {
            const char *name = extensions[i].extensionName;
            video_queue |= strcmp(name, "VK_KHR_video_queue") == 0;
            video_decode |= strcmp(name, "VK_KHR_video_decode_queue") == 0;
            h264 |= strcmp(name, "VK_KHR_video_decode_h264") == 0;
            av1 |= strcmp(name, "VK_KHR_video_decode_av1") == 0;
        }
        moonlightReport("vulkan.extensions: %u", count);
        moonlightReport("vulkan.video.advertised: queue=%u decode=%u h264=%u av1=%u",
            video_queue, video_decode, h264, av1);
        moonlightReport("video.decode: not tested");
        free(extensions);
        return true;
    }

    moonlightReport("vulkan.extensions: enumeration kept changing");
    return false;
}

static bool inspect_device(VkPhysicalDevice device)
{
    VkPhysicalDeviceProperties properties;
    vkGetPhysicalDeviceProperties(device, &properties);
    moonlightReport("vulkan.device: %.255s", properties.deviceName);
    moonlightReport("vulkan.identity: vendor=%04x device=%04x driver=%u",
        properties.vendorID, properties.deviceID, properties.driverVersion);
    moonlightReport("vulkan.api: %u.%u.%u", VK_API_VERSION_MAJOR(properties.apiVersion),
        VK_API_VERSION_MINOR(properties.apiVersion), VK_API_VERSION_PATCH(properties.apiVersion));

    uint32_t count = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(device, &count, NULL);
    if (!count || count > 64) {
        moonlightReport("vulkan.queues: invalid count %u", count);
        return false;
    }
    VkQueueFamilyProperties *queues = calloc(count, sizeof(*queues));
    if (!queues) {
        moonlightReport("vulkan.queues: allocation failed");
        return false;
    }
    vkGetPhysicalDeviceQueueFamilyProperties(device, &count, queues);
    for (uint32_t i = 0; i < count; i++) {
        moonlightReport("vulkan.queue.%u: count=%u flags=0x%x", i,
            queues[i].queueCount, queues[i].queueFlags);
    }
    free(queues);
    return device_extensions(device);
}

bool moonlightProbeVulkan(void)
{
    const VkApplicationInfo app = {
        .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
        .pApplicationName = "Moonlight NX2 compatibility",
        .apiVersion = VK_API_VERSION_1_0,
    };
    const VkInstanceCreateInfo info = {
        .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
        .pApplicationInfo = &app,
    };
    VkInstance instance = VK_NULL_HANDLE;
    VkResult rc = vkCreateInstance(&info, NULL, &instance);
    if (rc != VK_SUCCESS) {
        moonlightReport("vulkan.instance: failed (%d)", rc);
        return false;
    }

    bool success = false;
    for (unsigned attempt = 0; attempt < 3; attempt++) {
        uint32_t count = 0;
        rc = vkEnumeratePhysicalDevices(instance, &count, NULL);
        if (rc != VK_SUCCESS || !count || count > 32) {
            moonlightReport("vulkan.devices: count failed (%d, %u)", rc, count);
            break;
        }
        VkPhysicalDevice *devices = calloc(count, sizeof(*devices));
        if (!devices) {
            moonlightReport("vulkan.devices: allocation failed");
            break;
        }
        rc = vkEnumeratePhysicalDevices(instance, &count, devices);
        if (rc == VK_INCOMPLETE) {
            free(devices);
            continue;
        }
        if (rc != VK_SUCCESS) {
            moonlightReport("vulkan.devices: enumeration failed (%d)", rc);
            free(devices);
            break;
        }

        success = count > 0;
        for (uint32_t i = 0; i < count; i++) {
            if (!inspect_device(devices[i]))
                success = false;
        }
        free(devices);
        break;
    }

    vkDestroyInstance(instance, NULL);
    return success;
}
