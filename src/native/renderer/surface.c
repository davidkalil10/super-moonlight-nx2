#include "internal.h"

#if defined(__SWITCH__) || defined(__SWITCH2__)
#include <switch.h>

static const char *const extensions[] = {
    VK_KHR_SURFACE_EXTENSION_NAME,
    VK_NN_VI_SURFACE_EXTENSION_NAME,
};

VkResult moonlightSurfaceCreate(MoonlightRenderer *renderer)
{
    NWindow *window = nwindowGetDefault();
    Result rc = nwindowSetDimensions(window, renderer->config.width, renderer->config.height);
    if (R_FAILED(rc)) {
        moonlightRendererLogf(renderer, "renderer.window: dimensions failed 0x%08x", rc);
        return VK_ERROR_INITIALIZATION_FAILED;
    }

    const VkViSurfaceCreateInfoNN info = {
        .sType = VK_STRUCTURE_TYPE_VI_SURFACE_CREATE_INFO_NN,
        .window = window,
    };
    return vkCreateViSurfaceNN(renderer->instance, &info, renderer->allocator, &renderer->surface);
}

uint32_t moonlightSurfaceRelease(void)
{
    return nwindowReleaseVi2Layer(nwindowGetDefault());
}

uint64_t moonlightNowNs(void)
{
    return armTicksToNs(armGetSystemTick());
}

VkImageUsageFlags moonlightSurfaceExtraUsage(void)
{
    return 0;
}
#else
#include <time.h>

static const char *const extensions[] = {
    VK_KHR_SURFACE_EXTENSION_NAME,
    VK_EXT_HEADLESS_SURFACE_EXTENSION_NAME,
};

VkResult moonlightSurfaceCreate(MoonlightRenderer *renderer)
{
    const VkHeadlessSurfaceCreateInfoEXT info = {
        .sType = VK_STRUCTURE_TYPE_HEADLESS_SURFACE_CREATE_INFO_EXT,
    };
    return vkCreateHeadlessSurfaceEXT(renderer->instance, &info, renderer->allocator, &renderer->surface);
}

uint32_t moonlightSurfaceRelease(void)
{
    return 0;
}

uint64_t moonlightNowNs(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * UINT64_C(1000000000) + (uint64_t)now.tv_nsec;
}

VkImageUsageFlags moonlightSurfaceExtraUsage(void)
{
    return VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
}
#endif

const char *const *moonlightSurfaceExtensions(uint32_t *count)
{
    *count = sizeof(extensions) / sizeof(extensions[0]);
    return extensions;
}
