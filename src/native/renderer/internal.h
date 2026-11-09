#pragma once

#include <stdbool.h>
#include <stdint.h>

#if defined(__SWITCH__) || defined(__SWITCH2__)
#define VK_USE_PLATFORM_VI_NN 1
#endif
#include <vulkan/vulkan.h>

#include "../renderer.h"

#define ML_FRAMES_IN_FLIGHT 2u
#define ML_MAX_SWAPCHAIN_IMAGES 8u
#define ML_NO_SLOT UINT32_MAX

typedef struct {
    VkCommandBuffer command;
    VkFence fence;
    VkSemaphore acquired;
    uint32_t slot;
    bool pending;
} MoonlightFlight;

typedef struct {
    VkImage image;
    VkImageView view;
    VkFramebuffer framebuffer;
    VkSemaphore rendered;
} MoonlightTarget;

typedef struct {
    VkBuffer buffer;
    VkDeviceMemory memory;
    uint8_t *mapped;
    VkDeviceSize size;
} MoonlightBuffer;

struct MoonlightRenderer {
    MoonlightRendererLog log;
    const VkAllocationCallbacks *allocator;
    MoonlightRendererConfig config;

    VkInstance instance;
    VkSurfaceKHR surface;
    VkPhysicalDevice physical;
    uint32_t queue_family;
    VkDevice device;
    VkQueue queue;

    MoonlightBuffer input;
    MoonlightBuffer storage;
    VkBufferView texel_views[2];
    MoonlightVideoPath video_path;

    VkDescriptorSetLayout set_layout;
    VkDescriptorPool descriptor_pool;
    VkDescriptorSet set;
    VkPipelineLayout pipeline_layout;
    VkRenderPass render_pass;
    VkPipeline compute;
    VkPipeline video;
    VkPipeline ui;
    VkPipelineCache pipeline_cache;
    MoonlightCacheState cache_state;
    bool cache_saved;
    VkCommandPool command_pool;

    VkSurfaceFormatKHR format;
    VkExtent2D extent;
    VkSwapchainKHR swapchain;
    uint32_t image_count;
    MoonlightTarget targets[ML_MAX_SWAPCHAIN_IMAGES];
    bool rebuild;
    bool lost;
    bool retained;

    MoonlightFlight flights[ML_FRAMES_IN_FLIGHT];
    uint32_t next_flight;
    uint32_t slot_readers[2];
    uint32_t current_slot;
    uint32_t sequence;
    uint32_t last_image;

    uint64_t presented;
    uint64_t busy_uploads;
    uint64_t swapchain_rebuilds;
    uint64_t startup_ns;
    MoonlightTiming upload;
    MoonlightTiming acquire;
    MoonlightTiming submit;
    MoonlightTiming fence;
    MoonlightTiming present;
    MoonlightTiming upload_wait;
};

const char *const *moonlightSurfaceExtensions(uint32_t *count);
VkResult moonlightSurfaceCreate(MoonlightRenderer *renderer);
uint32_t moonlightSurfaceRelease(void);
uint64_t moonlightNowNs(void);
VkImageUsageFlags moonlightSurfaceExtraUsage(void);

void moonlightRendererLogf(const MoonlightRenderer *renderer, const char *format, ...)
    __attribute__((format(printf, 2, 3)));

VkResult moonlightRendererInject(void);

#ifdef MOONLIGHT_RENDERER_TEST
extern uint32_t moonlight_renderer_fail_at;
extern uint32_t moonlight_renderer_calls;
extern const VkAllocationCallbacks *moonlight_renderer_test_allocator;
extern uint64_t moonlight_renderer_test_shader_salt;
extern bool moonlight_renderer_test_fence_timeout;
extern uint32_t moonlight_renderer_test_fence_waits;
MoonlightRenderResult moonlightRendererReadback(MoonlightRenderer *renderer, uint8_t *rgba, size_t bytes);
#endif
