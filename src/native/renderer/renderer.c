#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cache.h"
#include "frame.h"
#include "internal.h"
#include "layout.h"
#include "shaders.h"

#define ML_WAIT_NS UINT64_C(2000000000)
#define ML_CREATE(call) (moonlightRendererInject() == VK_SUCCESS ? (call) : VK_ERROR_OUT_OF_HOST_MEMORY)

#ifdef MOONLIGHT_RENDERER_TEST
uint32_t moonlight_renderer_fail_at;
uint32_t moonlight_renderer_calls;
const VkAllocationCallbacks *moonlight_renderer_test_allocator;
uint64_t moonlight_renderer_test_shader_salt;
bool moonlight_renderer_test_fence_timeout;
uint32_t moonlight_renderer_test_fence_waits;
#define ML_FINAL_LAYOUT VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL
#else
#define ML_FINAL_LAYOUT VK_IMAGE_LAYOUT_PRESENT_SRC_KHR
#endif

typedef struct {
    MoonlightRenderResult result;
    const char *what;
} Failure;

static MoonlightRenderer *open_renderer;

VkResult moonlightRendererInject(void)
{
#ifdef MOONLIGHT_RENDERER_TEST
    moonlight_renderer_calls++;
    if (moonlight_renderer_fail_at && moonlight_renderer_calls == moonlight_renderer_fail_at)
        return VK_ERROR_OUT_OF_HOST_MEMORY;
#endif
    return VK_SUCCESS;
}

void moonlightRendererLogf(const MoonlightRenderer *renderer, const char *format, ...)
{
    if (!renderer->log)
        return;

    char message[256];
    va_list args;
    va_start(args, format);
    vsnprintf(message, sizeof(message), format, args);
    va_end(args);
    renderer->log(message);
}

const char *moonlightRenderResultName(MoonlightRenderResult result)
{
    switch (result) {
    case MOONLIGHT_RENDER_OK: return "ok";
    case MOONLIGHT_RENDER_BUSY: return "busy";
    case MOONLIGHT_RENDER_INVALID: return "invalid";
    case MOONLIGHT_RENDER_UNSUPPORTED: return "unsupported";
    case MOONLIGHT_RENDER_NO_MEMORY: return "no-memory";
    case MOONLIGHT_RENDER_DEVICE: return "device";
    case MOONLIGHT_RENDER_LOST: return "lost";
    case MOONLIGHT_RENDER_RETAINED: return "retained";
    }
    return "unknown";
}

static MoonlightRenderResult from_vk(VkResult rc)
{
    switch (rc) {
    case VK_SUCCESS: return MOONLIGHT_RENDER_OK;
    case VK_TIMEOUT:
    case VK_NOT_READY: return MOONLIGHT_RENDER_BUSY;
    case VK_ERROR_OUT_OF_HOST_MEMORY:
    case VK_ERROR_OUT_OF_DEVICE_MEMORY: return MOONLIGHT_RENDER_NO_MEMORY;
    case VK_ERROR_DEVICE_LOST: return MOONLIGHT_RENDER_LOST;
    case VK_ERROR_EXTENSION_NOT_PRESENT:
    case VK_ERROR_FEATURE_NOT_PRESENT:
    case VK_ERROR_FORMAT_NOT_SUPPORTED:
    case VK_ERROR_INCOMPATIBLE_DRIVER: return MOONLIGHT_RENDER_UNSUPPORTED;
    default: return MOONLIGHT_RENDER_DEVICE;
    }
}

static bool failed(MoonlightRenderer *r, Failure *failure, VkResult rc, const char *what)
{
    if (rc == VK_SUCCESS)
        return false;

    moonlightRendererLogf(r, "renderer.%s: failed (%d)", what, rc);
    *failure = (Failure){from_vk(rc), what};
    return true;
}

static bool refuse(MoonlightRenderer *r, Failure *failure, MoonlightRenderResult result, const char *what)
{
    moonlightRendererLogf(r, "renderer.%s: %s", what, moonlightRenderResultName(result));
    *failure = (Failure){result, what};
    return true;
}

static void timing_add(MoonlightTiming *timing, uint64_t started_ns)
{
    const uint64_t elapsed = moonlightNowNs() - started_ns;
    timing->count++;
    timing->total_ns += elapsed;
    if (elapsed > timing->max_ns)
        timing->max_ns = elapsed;
}

static void write_word(MoonlightRenderer *r, uint32_t offset, uint32_t value)
{
    memcpy(r->storage.mapped + offset, &value, sizeof(value));
}

static bool create_instance(MoonlightRenderer *r, Failure *failure)
{
    uint32_t count = 0;
    const char *const *extensions = moonlightSurfaceExtensions(&count);
    const VkApplicationInfo app = {
        .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
        .pApplicationName = "Moonlight NX2",
        .apiVersion = VK_API_VERSION_1_0,
    };
    const VkInstanceCreateInfo info = {
        .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
        .pApplicationInfo = &app,
        .enabledExtensionCount = count,
        .ppEnabledExtensionNames = extensions,
    };
    if (failed(r, failure, ML_CREATE(vkCreateInstance(&info, r->allocator, &r->instance)), "instance"))
        return false;

    return !failed(r, failure, ML_CREATE(moonlightSurfaceCreate(r)), "surface");
}

static bool queue_family(MoonlightRenderer *r, VkPhysicalDevice physical, uint32_t *out)
{
    uint32_t count = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(physical, &count, NULL);
    VkQueueFamilyProperties families[16];
    if (count > 16)
        count = 16;
    vkGetPhysicalDeviceQueueFamilyProperties(physical, &count, families);

    const VkQueueFlags needed = VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT;
    for (uint32_t i = 0; i < count; i++) {
        VkBool32 present = VK_FALSE;
        if ((families[i].queueFlags & needed) != needed)
            continue;
        if (vkGetPhysicalDeviceSurfaceSupportKHR(physical, i, r->surface, &present) != VK_SUCCESS)
            continue;
        if (present) {
            *out = i;
            return true;
        }
    }
    return false;
}

static bool choose_physical(MoonlightRenderer *r, Failure *failure)
{
    VkPhysicalDevice devices[8];
    uint32_t count = 8;
    VkResult rc = vkEnumeratePhysicalDevices(r->instance, &count, devices);
    if (rc != VK_SUCCESS && rc != VK_INCOMPLETE)
        return !failed(r, failure, rc, "devices");

    for (uint32_t i = 0; i < count; i++) {
        if (queue_family(r, devices[i], &r->queue_family)) {
            r->physical = devices[i];
            VkPhysicalDeviceProperties properties;
            vkGetPhysicalDeviceProperties(r->physical, &properties);
            moonlightRendererLogf(r, "renderer.device: %.200s queue=%u", properties.deviceName, r->queue_family);
            return true;
        }
    }
    return !refuse(r, failure, MOONLIGHT_RENDER_UNSUPPORTED, "queue");
}

static bool create_device(MoonlightRenderer *r, Failure *failure)
{
    const float priority = 1.0f;
    const VkDeviceQueueCreateInfo queue = {
        .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
        .queueFamilyIndex = r->queue_family,
        .queueCount = 1,
        .pQueuePriorities = &priority,
    };
    const char *extensions[] = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};
    const VkDeviceCreateInfo info = {
        .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
        .queueCreateInfoCount = 1,
        .pQueueCreateInfos = &queue,
        .enabledExtensionCount = 1,
        .ppEnabledExtensionNames = extensions,
    };
    if (failed(r, failure, ML_CREATE(vkCreateDevice(r->physical, &info, r->allocator, &r->device)), "device"))
        return false;

    vkGetDeviceQueue(r->device, r->queue_family, 0, &r->queue);
    return true;
}

static bool texel_format(VkPhysicalDevice physical, VkFormat format)
{
    VkFormatProperties properties;
    vkGetPhysicalDeviceFormatProperties(physical, format, &properties);
    return (properties.bufferFeatures & VK_FORMAT_FEATURE_UNIFORM_TEXEL_BUFFER_BIT) != 0;
}

static bool choose_video_path(MoonlightRenderer *r, Failure *failure)
{
    VkPhysicalDeviceProperties properties;
    vkGetPhysicalDeviceProperties(r->physical, &properties);
    const VkPhysicalDeviceLimits *limits = &properties.limits;
    if (limits->maxStorageBufferRange < ML_STORAGE_BYTES)
        return !refuse(r, failure, MOONLIGHT_RENDER_UNSUPPORTED, "storage-range");

    const uint64_t elements = (uint64_t)ML_VIDEO_SLOTS * ML_FRAME_BYTES;
    const bool limitOk = limits->maxTexelBufferElements >= elements;
    const bool alignOk = ML_FRAMES_OFFSET % limits->minTexelBufferOffsetAlignment == 0;
    const bool formatOk = texel_format(r->physical, VK_FORMAT_R8_UNORM) && texel_format(r->physical, VK_FORMAT_R8G8_UNORM);

    r->video_path = MOONLIGHT_VIDEO_PATH_STORAGE_BUFFER;
    if (limitOk && alignOk && formatOk && !r->config.prefer_storage_path)
        r->video_path = MOONLIGHT_VIDEO_PATH_TEXEL_BUFFER;

    moonlightRendererLogf(r, "renderer.video-path: %s texel-elements=%u align=%llu formats=%u",
        r->video_path == MOONLIGHT_VIDEO_PATH_TEXEL_BUFFER ? "texel-buffer" : "storage-buffer",
        limits->maxTexelBufferElements, (unsigned long long)limits->minTexelBufferOffsetAlignment, formatOk);
    return true;
}

static bool memory_type(MoonlightRenderer *r, uint32_t allowed, uint32_t *out)
{
    VkPhysicalDeviceMemoryProperties properties;
    vkGetPhysicalDeviceMemoryProperties(r->physical, &properties);
    const VkMemoryPropertyFlags host = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;

    for (int pass = 0; pass < 2; pass++) {
        const VkMemoryPropertyFlags wanted = pass == 0 ? host | VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT : host;
        for (uint32_t type = 0; type < properties.memoryTypeCount; type++) {
            const VkMemoryPropertyFlags flags = properties.memoryTypes[type].propertyFlags;
            if ((allowed & (1u << type)) && (flags & wanted) == wanted) {
                *out = type;
                return true;
            }
        }
    }
    return false;
}

static bool create_buffer(MoonlightRenderer *r, Failure *failure, MoonlightBuffer *b, VkDeviceSize size,
    VkBufferUsageFlags usage, const char *what)
{
    const VkBufferCreateInfo info = {
        .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
        .size = size,
        .usage = usage,
        .sharingMode = VK_SHARING_MODE_EXCLUSIVE,
    };
    if (failed(r, failure, ML_CREATE(vkCreateBuffer(r->device, &info, r->allocator, &b->buffer)), what))
        return false;

    VkMemoryRequirements needs;
    vkGetBufferMemoryRequirements(r->device, b->buffer, &needs);
    uint32_t type = 0;
    if (!memory_type(r, needs.memoryTypeBits, &type))
        return !refuse(r, failure, MOONLIGHT_RENDER_UNSUPPORTED, what);

    const VkMemoryAllocateInfo allocate = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        .allocationSize = needs.size,
        .memoryTypeIndex = type,
    };
    if (failed(r, failure, ML_CREATE(vkAllocateMemory(r->device, &allocate, r->allocator, &b->memory)), what))
        return false;
    if (failed(r, failure, vkBindBufferMemory(r->device, b->buffer, b->memory, 0), what))
        return false;

    void *mapped = NULL;
    if (failed(r, failure, ML_CREATE(vkMapMemory(r->device, b->memory, 0, VK_WHOLE_SIZE, 0, &mapped)), what))
        return false;

    b->mapped = mapped;
    b->size = size;
    memset(b->mapped, 0, (size_t)size);
    return true;
}

static void destroy_buffer(MoonlightRenderer *r, MoonlightBuffer *b)
{
    if (b->mapped)
        vkUnmapMemory(r->device, b->memory);
    if (b->buffer)
        vkDestroyBuffer(r->device, b->buffer, r->allocator);
    if (b->memory)
        vkFreeMemory(r->device, b->memory, r->allocator);
    *b = (MoonlightBuffer){0};
}

static bool create_buffers(MoonlightRenderer *r, Failure *failure)
{
    if (!create_buffer(r, failure, &r->input, ML_INPUT_BYTES, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, "input"))
        return false;

    const VkBufferUsageFlags usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_UNIFORM_TEXEL_BUFFER_BIT;
    if (!create_buffer(r, failure, &r->storage, ML_STORAGE_BYTES, usage, "storage"))
        return false;

    if (r->video_path != MOONLIGHT_VIDEO_PATH_TEXEL_BUFFER)
        return true;

    const VkFormat formats[2] = {VK_FORMAT_R8_UNORM, VK_FORMAT_R8G8_UNORM};
    for (int plane = 0; plane < 2; plane++) {
        const VkBufferViewCreateInfo info = {
            .sType = VK_STRUCTURE_TYPE_BUFFER_VIEW_CREATE_INFO,
            .buffer = r->storage.buffer,
            .format = formats[plane],
            .offset = ML_FRAMES_OFFSET,
            .range = (VkDeviceSize)ML_VIDEO_SLOTS * ML_FRAME_BYTES,
        };
        VkResult rc = ML_CREATE(vkCreateBufferView(r->device, &info, r->allocator, &r->texel_views[plane]));
        if (failed(r, failure, rc, "texel-view"))
            return false;
    }
    return true;
}

static bool create_set(MoonlightRenderer *r, Failure *failure)
{
    const VkShaderStageFlags all = VK_SHADER_STAGE_ALL_GRAPHICS | VK_SHADER_STAGE_COMPUTE_BIT;
    const VkDescriptorSetLayoutBinding bindings[4] = {
        {0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, all, NULL},
        {1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, all, NULL},
        {2, VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL},
        {3, VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL},
    };
    const bool texel = r->video_path == MOONLIGHT_VIDEO_PATH_TEXEL_BUFFER;
    const VkDescriptorSetLayoutCreateInfo layout = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
        .bindingCount = texel ? 4 : 2,
        .pBindings = bindings,
    };
    VkResult rc = ML_CREATE(vkCreateDescriptorSetLayout(r->device, &layout, r->allocator, &r->set_layout));
    if (failed(r, failure, rc, "set-layout"))
        return false;

    const VkDescriptorPoolSize sizes[2] = {
        {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 2},
        {VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 2},
    };
    const VkDescriptorPoolCreateInfo pool = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
        .maxSets = 1,
        .poolSizeCount = texel ? 2 : 1,
        .pPoolSizes = sizes,
    };
    rc = ML_CREATE(vkCreateDescriptorPool(r->device, &pool, r->allocator, &r->descriptor_pool));
    if (failed(r, failure, rc, "descriptor-pool"))
        return false;

    const VkDescriptorSetAllocateInfo allocate = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
        .descriptorPool = r->descriptor_pool,
        .descriptorSetCount = 1,
        .pSetLayouts = &r->set_layout,
    };
    if (failed(r, failure, ML_CREATE(vkAllocateDescriptorSets(r->device, &allocate, &r->set)), "set"))
        return false;

    const VkDescriptorBufferInfo buffers[2] = {
        {r->input.buffer, 0, ML_INPUT_BYTES},
        {r->storage.buffer, 0, ML_STORAGE_BYTES},
    };
    const VkWriteDescriptorSet writes[2] = {
        {.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = r->set, .descriptorCount = 2,
            .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = buffers},
        {.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = r->set, .dstBinding = 2, .descriptorCount = 2,
            .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, .pTexelBufferView = r->texel_views},
    };
    vkUpdateDescriptorSets(r->device, texel ? 2 : 1, writes, 0, NULL);

    const VkPipelineLayoutCreateInfo pipeline = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount = 1,
        .pSetLayouts = &r->set_layout,
    };
    rc = ML_CREATE(vkCreatePipelineLayout(r->device, &pipeline, r->allocator, &r->pipeline_layout));
    return !failed(r, failure, rc, "pipeline-layout");
}

static bool usable_format(VkFormat format)
{
    return format == VK_FORMAT_R8G8B8A8_UNORM || format == VK_FORMAT_B8G8R8A8_UNORM ||
           format == VK_FORMAT_A8B8G8R8_UNORM_PACK32;
}

static bool choose_format(MoonlightRenderer *r, Failure *failure)
{
    VkSurfaceFormatKHR formats[32];
    uint32_t count = 32;
    VkResult rc = vkGetPhysicalDeviceSurfaceFormatsKHR(r->physical, r->surface, &count, formats);
    if (rc != VK_SUCCESS && rc != VK_INCOMPLETE)
        return !failed(r, failure, rc, "surface-formats");

    for (uint32_t i = 0; i < count; i++) {
        if (formats[i].format == VK_FORMAT_R8G8B8A8_UNORM) {
            r->format = formats[i];
            return true;
        }
    }
    for (uint32_t i = 0; i < count; i++) {
        if (usable_format(formats[i].format)) {
            r->format = formats[i];
            return true;
        }
    }
    return !refuse(r, failure, MOONLIGHT_RENDER_UNSUPPORTED, "surface-format");
}

static bool create_render_pass(MoonlightRenderer *r, Failure *failure)
{
    const VkAttachmentDescription attachment = {
        .format = r->format.format,
        .samples = VK_SAMPLE_COUNT_1_BIT,
        .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
        .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
        .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
        .stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE,
        .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
        .finalLayout = ML_FINAL_LAYOUT,
    };
    const VkAttachmentReference color = {0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
    const VkSubpassDescription subpass = {
        .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS,
        .colorAttachmentCount = 1,
        .pColorAttachments = &color,
    };
    const VkSubpassDependency dependency = {
        .srcSubpass = VK_SUBPASS_EXTERNAL,
        .dstSubpass = 0,
        .srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
        .dstStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
        .dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT,
    };
    const VkRenderPassCreateInfo info = {
        .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO,
        .attachmentCount = 1,
        .pAttachments = &attachment,
        .subpassCount = 1,
        .pSubpasses = &subpass,
        .dependencyCount = 1,
        .pDependencies = &dependency,
    };
    VkResult rc = ML_CREATE(vkCreateRenderPass(r->device, &info, r->allocator, &r->render_pass));
    return !failed(r, failure, rc, "render-pass");
}

static VkResult shader(MoonlightRenderer *r, const uint32_t *code, size_t bytes, VkShaderModule *out)
{
    const VkShaderModuleCreateInfo info = {
        .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
        .codeSize = bytes,
        .pCode = code,
    };
    return ML_CREATE(vkCreateShaderModule(r->device, &info, r->allocator, out));
}

static VkResult graphics_pipeline(MoonlightRenderer *r, VkShaderModule vertex, VkShaderModule fragment,
    bool blended, VkPipeline *out)
{
    const VkPipelineShaderStageCreateInfo stages[2] = {
        {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT,
            .module = vertex, .pName = "main"},
        {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT,
            .module = fragment, .pName = "main"},
    };
    const VkPipelineVertexInputStateCreateInfo input = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO,
    };
    const VkPipelineInputAssemblyStateCreateInfo assembly = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
        .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST,
    };
    const VkPipelineViewportStateCreateInfo viewport = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO,
        .viewportCount = 1,
        .scissorCount = 1,
    };
    const VkPipelineRasterizationStateCreateInfo raster = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
        .lineWidth = 1.0f,
    };
    const VkPipelineMultisampleStateCreateInfo multisample = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
        .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT,
    };
    const VkPipelineColorBlendAttachmentState attachment = {
        .blendEnable = blended,
        .srcColorBlendFactor = blended ? VK_BLEND_FACTOR_SRC_ALPHA : VK_BLEND_FACTOR_ZERO,
        .dstColorBlendFactor = blended ? VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA : VK_BLEND_FACTOR_ZERO,
        .srcAlphaBlendFactor = blended ? VK_BLEND_FACTOR_ONE : VK_BLEND_FACTOR_ZERO,
        .dstAlphaBlendFactor = blended ? VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA : VK_BLEND_FACTOR_ZERO,
        .colorWriteMask = 0xf,
    };
    const VkPipelineColorBlendStateCreateInfo blend = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
        .attachmentCount = 1,
        .pAttachments = &attachment,
    };
    const VkDynamicState dynamic_states[2] = {VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR};
    const VkPipelineDynamicStateCreateInfo dynamic = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO,
        .dynamicStateCount = 2,
        .pDynamicStates = dynamic_states,
    };
    const VkGraphicsPipelineCreateInfo info = {
        .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO,
        .stageCount = 2,
        .pStages = stages,
        .pVertexInputState = &input,
        .pInputAssemblyState = &assembly,
        .pViewportState = &viewport,
        .pRasterizationState = &raster,
        .pMultisampleState = &multisample,
        .pColorBlendState = &blend,
        .pDynamicState = &dynamic,
        .layout = r->pipeline_layout,
        .renderPass = r->render_pass,
        .basePipelineIndex = -1,
    };
    return ML_CREATE(vkCreateGraphicsPipelines(r->device, r->pipeline_cache, 1, &info, r->allocator, out));
}

typedef struct {
    VkShaderModule publish, video_vertex, video_fragment, ui_vertex, ui_fragment;
} Modules;

static uint64_t shaders_hash(void)
{
    uint64_t hash = mlHashStart();
    hash = mlHash(hash, moonlight_spirv_publish, sizeof(moonlight_spirv_publish));
    hash = mlHash(hash, moonlight_spirv_video_vertex, sizeof(moonlight_spirv_video_vertex));
    hash = mlHash(hash, moonlight_spirv_video_fragment, sizeof(moonlight_spirv_video_fragment));
    hash = mlHash(hash, moonlight_spirv_video_storage_fragment, sizeof(moonlight_spirv_video_storage_fragment));
    hash = mlHash(hash, moonlight_spirv_ui_vertex, sizeof(moonlight_spirv_ui_vertex));
    hash = mlHash(hash, moonlight_spirv_ui_fragment, sizeof(moonlight_spirv_ui_fragment));
#ifdef MOONLIGHT_RENDERER_TEST
    hash = mlHash(hash, &moonlight_renderer_test_shader_salt, sizeof(moonlight_renderer_test_shader_salt));
#endif
    return hash;
}

static MoonlightCacheIdentity cache_identity(const MoonlightRenderer *r)
{
    VkPhysicalDeviceProperties properties;
    vkGetPhysicalDeviceProperties(r->physical, &properties);

    MoonlightCacheIdentity identity = {
        .vendor = properties.vendorID,
        .device = properties.deviceID,
        .driver = properties.driverVersion,
        .width = r->config.width,
        .height = r->config.height,
        .video_path = (uint32_t)r->video_path,
        .format = (uint32_t)r->format.format,
        .abi = ML_LAYOUT_ABI,
        .storage_bytes = ML_STORAGE_BYTES,
        .frame_bytes = ML_FRAME_BYTES,
        .frames_offset = ML_FRAMES_OFFSET,
        .shaders = shaders_hash(),
    };
    memcpy(identity.uuid, properties.pipelineCacheUUID, sizeof(identity.uuid));
    return identity;
}

static VkResult new_pipeline_cache(MoonlightRenderer *r, const void *data, size_t bytes)
{
    const VkPipelineCacheCreateInfo info = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_CACHE_CREATE_INFO,
        .initialDataSize = bytes,
        .pInitialData = data,
    };
    return ML_CREATE(vkCreatePipelineCache(r->device, &info, r->allocator, &r->pipeline_cache));
}

static void open_pipeline_cache(MoonlightRenderer *r)
{
    const char *path = r->config.pipeline_cache_path;
    if (!path)
        return;

    const MoonlightCacheIdentity identity = cache_identity(r);
    void *data = NULL;
    size_t bytes = 0;
    const char *reason = mlCacheLoad(path, &identity, &data, &bytes);
    if (!reason && new_pipeline_cache(r, data, bytes) == VK_SUCCESS) {
        r->cache_state = MOONLIGHT_CACHE_HIT;
        moonlightRendererLogf(r, "renderer.cache: hit %zu bytes", bytes);
        free(data);
        return;
    }
    free(data);
    r->pipeline_cache = VK_NULL_HANDLE;

    if (new_pipeline_cache(r, NULL, 0) != VK_SUCCESS) {
        r->pipeline_cache = VK_NULL_HANDLE;
        r->cache_state = MOONLIGHT_CACHE_UNAVAILABLE;
        moonlightRendererLogf(r, "renderer.cache: unavailable");
        return;
    }
    r->cache_state = MOONLIGHT_CACHE_MISS;
    moonlightRendererLogf(r, "renderer.cache: miss (%s)", reason ? reason : "driver");
}

static void save_pipeline_cache(MoonlightRenderer *r)
{
    if (r->cache_state != MOONLIGHT_CACHE_MISS)
        return;

    size_t bytes = 0;
    VkResult rc = vkGetPipelineCacheData(r->device, r->pipeline_cache, &bytes, NULL);
    if (rc != VK_SUCCESS || !bytes || bytes > ML_CACHE_MAX_BYTES - sizeof(MoonlightCacheHeader)) {
        moonlightRendererLogf(r, "renderer.cache: not saved (size %d, %zu)", rc, bytes);
        return;
    }

    void *data = malloc(bytes);
    if (!data) {
        moonlightRendererLogf(r, "renderer.cache: not saved (memory)");
        return;
    }

    const char *reason = "data";
    if (vkGetPipelineCacheData(r->device, r->pipeline_cache, &bytes, data) == VK_SUCCESS) {
        const MoonlightCacheIdentity identity = cache_identity(r);
        reason = mlCacheSave(r->config.pipeline_cache_path, &identity, data, bytes);
    }
    free(data);

    r->cache_saved = reason == NULL;
    if (reason)
        moonlightRendererLogf(r, "renderer.cache: not saved (%s)", reason);
    else
        moonlightRendererLogf(r, "renderer.cache: saved %zu bytes", bytes);
}

static void close_pipeline_cache(MoonlightRenderer *r)
{
    if (!r->pipeline_cache)
        return;

    vkDestroyPipelineCache(r->device, r->pipeline_cache, r->allocator);
    r->pipeline_cache = VK_NULL_HANDLE;
}

static VkResult build_pipelines(MoonlightRenderer *r, const Modules *m)
{
    const VkComputePipelineCreateInfo compute = {
        .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage = {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
            .module = m->publish, .pName = "main"},
        .layout = r->pipeline_layout,
        .basePipelineIndex = -1,
    };
    VkResult rc = ML_CREATE(vkCreateComputePipelines(r->device, r->pipeline_cache, 1, &compute, r->allocator, &r->compute));
    if (rc != VK_SUCCESS)
        return rc;

    rc = graphics_pipeline(r, m->video_vertex, m->video_fragment, false, &r->video);
    if (rc != VK_SUCCESS)
        return rc;

    return graphics_pipeline(r, m->ui_vertex, m->ui_fragment, true, &r->ui);
}

static bool create_pipelines(MoonlightRenderer *r, Failure *failure)
{
    const bool texel = r->video_path == MOONLIGHT_VIDEO_PATH_TEXEL_BUFFER;
    const uint32_t *fragment = texel ? moonlight_spirv_video_fragment : moonlight_spirv_video_storage_fragment;
    const size_t fragment_bytes = texel ? sizeof(moonlight_spirv_video_fragment)
                                        : sizeof(moonlight_spirv_video_storage_fragment);

    open_pipeline_cache(r);
    Modules m = {0};
    VkResult rc = shader(r, moonlight_spirv_publish, sizeof(moonlight_spirv_publish), &m.publish);
    if (rc == VK_SUCCESS)
        rc = shader(r, moonlight_spirv_video_vertex, sizeof(moonlight_spirv_video_vertex), &m.video_vertex);
    if (rc == VK_SUCCESS)
        rc = shader(r, fragment, fragment_bytes, &m.video_fragment);
    if (rc == VK_SUCCESS)
        rc = shader(r, moonlight_spirv_ui_vertex, sizeof(moonlight_spirv_ui_vertex), &m.ui_vertex);
    if (rc == VK_SUCCESS)
        rc = shader(r, moonlight_spirv_ui_fragment, sizeof(moonlight_spirv_ui_fragment), &m.ui_fragment);
    if (rc == VK_SUCCESS)
        rc = build_pipelines(r, &m);

    const VkShaderModule modules[] = {m.publish, m.video_vertex, m.video_fragment, m.ui_vertex, m.ui_fragment};
    for (size_t i = 0; i < sizeof(modules) / sizeof(modules[0]); i++) {
        if (modules[i])
            vkDestroyShaderModule(r->device, modules[i], r->allocator);
    }
    if (rc == VK_SUCCESS)
        save_pipeline_cache(r);
    close_pipeline_cache(r);
    return !failed(r, failure, rc, "pipelines");
}

static bool create_flights(MoonlightRenderer *r, Failure *failure)
{
    const VkCommandPoolCreateInfo pool = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
        .flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT,
        .queueFamilyIndex = r->queue_family,
    };
    VkResult rc = ML_CREATE(vkCreateCommandPool(r->device, &pool, r->allocator, &r->command_pool));
    if (failed(r, failure, rc, "command-pool"))
        return false;

    const VkFenceCreateInfo fence = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    const VkSemaphoreCreateInfo semaphore = {.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
    for (uint32_t i = 0; i < ML_FRAMES_IN_FLIGHT; i++) {
        MoonlightFlight *flight = &r->flights[i];
        flight->slot = ML_NO_SLOT;
        const VkCommandBufferAllocateInfo allocate = {
            .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
            .commandPool = r->command_pool,
            .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
            .commandBufferCount = 1,
        };
        if (failed(r, failure, ML_CREATE(vkAllocateCommandBuffers(r->device, &allocate, &flight->command)), "command"))
            return false;
        if (failed(r, failure, ML_CREATE(vkCreateFence(r->device, &fence, r->allocator, &flight->fence)), "fence"))
            return false;
        rc = ML_CREATE(vkCreateSemaphore(r->device, &semaphore, r->allocator, &flight->acquired));
        if (failed(r, failure, rc, "semaphore"))
            return false;
    }
    return true;
}

static void destroy_targets(MoonlightRenderer *r)
{
    for (uint32_t i = 0; i < ML_MAX_SWAPCHAIN_IMAGES; i++) {
        MoonlightTarget *t = &r->targets[i];
        if (t->framebuffer)
            vkDestroyFramebuffer(r->device, t->framebuffer, r->allocator);
        if (t->view)
            vkDestroyImageView(r->device, t->view, r->allocator);
        if (t->rendered)
            vkDestroySemaphore(r->device, t->rendered, r->allocator);
        *t = (MoonlightTarget){0};
    }
    r->image_count = 0;
}

static bool create_target(MoonlightRenderer *r, Failure *failure, MoonlightTarget *t)
{
    const VkImageViewCreateInfo view = {
        .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO,
        .image = t->image,
        .viewType = VK_IMAGE_VIEW_TYPE_2D,
        .format = r->format.format,
        .subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1},
    };
    if (failed(r, failure, ML_CREATE(vkCreateImageView(r->device, &view, r->allocator, &t->view)), "image-view"))
        return false;

    const VkFramebufferCreateInfo framebuffer = {
        .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO,
        .renderPass = r->render_pass,
        .attachmentCount = 1,
        .pAttachments = &t->view,
        .width = r->extent.width,
        .height = r->extent.height,
        .layers = 1,
    };
    VkResult rc = ML_CREATE(vkCreateFramebuffer(r->device, &framebuffer, r->allocator, &t->framebuffer));
    if (failed(r, failure, rc, "framebuffer"))
        return false;

    const VkSemaphoreCreateInfo semaphore = {.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
    rc = ML_CREATE(vkCreateSemaphore(r->device, &semaphore, r->allocator, &t->rendered));
    return !failed(r, failure, rc, "semaphore");
}

static VkExtent2D surface_extent(const MoonlightRenderer *r, const VkSurfaceCapabilitiesKHR *caps)
{
    if (caps->currentExtent.width != UINT32_MAX)
        return caps->currentExtent;

    VkExtent2D extent = {r->config.width, r->config.height};
    if (extent.width < caps->minImageExtent.width) extent.width = caps->minImageExtent.width;
    if (extent.height < caps->minImageExtent.height) extent.height = caps->minImageExtent.height;
    if (extent.width > caps->maxImageExtent.width) extent.width = caps->maxImageExtent.width;
    if (extent.height > caps->maxImageExtent.height) extent.height = caps->maxImageExtent.height;
    return extent;
}

static VkCompositeAlphaFlagBitsKHR composite_alpha(VkCompositeAlphaFlagsKHR supported)
{
    if (supported & VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR)
        return VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
    for (uint32_t bit = 1; bit; bit <<= 1) {
        if (supported & bit)
            return (VkCompositeAlphaFlagBitsKHR)bit;
    }
    return VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
}

static bool create_swapchain(MoonlightRenderer *r, Failure *failure)
{
    VkSurfaceCapabilitiesKHR caps;
    VkResult rc = vkGetPhysicalDeviceSurfaceCapabilitiesKHR(r->physical, r->surface, &caps);
    if (failed(r, failure, rc, "surface-caps"))
        return false;

    const VkImageUsageFlags usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | moonlightSurfaceExtraUsage();
    if ((caps.supportedUsageFlags & usage) != usage)
        return !refuse(r, failure, MOONLIGHT_RENDER_UNSUPPORTED, "surface-usage");

    uint32_t images = caps.minImageCount < 2 ? 2 : caps.minImageCount;
    if (caps.maxImageCount && images > caps.maxImageCount)
        images = caps.maxImageCount;

    VkSwapchainKHR old = r->swapchain;
    r->extent = surface_extent(r, &caps);
    const VkSwapchainCreateInfoKHR info = {
        .sType = VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR,
        .surface = r->surface,
        .minImageCount = images,
        .imageFormat = r->format.format,
        .imageColorSpace = r->format.colorSpace,
        .imageExtent = r->extent,
        .imageArrayLayers = 1,
        .imageUsage = usage,
        .imageSharingMode = VK_SHARING_MODE_EXCLUSIVE,
        .preTransform = caps.currentTransform,
        .compositeAlpha = composite_alpha(caps.supportedCompositeAlpha),
        .presentMode = VK_PRESENT_MODE_FIFO_KHR,
        .clipped = VK_TRUE,
        .oldSwapchain = old,
    };
    rc = ML_CREATE(vkCreateSwapchainKHR(r->device, &info, r->allocator, &r->swapchain));
    if (old)
        vkDestroySwapchainKHR(r->device, old, r->allocator);
    if (rc != VK_SUCCESS)
        r->swapchain = VK_NULL_HANDLE;
    if (failed(r, failure, rc, "swapchain"))
        return false;

    VkImage handles[ML_MAX_SWAPCHAIN_IMAGES];
    uint32_t count = ML_MAX_SWAPCHAIN_IMAGES;
    rc = vkGetSwapchainImagesKHR(r->device, r->swapchain, &count, handles);
    if (rc == VK_INCOMPLETE)
        return !refuse(r, failure, MOONLIGHT_RENDER_UNSUPPORTED, "swapchain-images");
    if (failed(r, failure, rc, "swapchain-images"))
        return false;

    for (uint32_t i = 0; i < count; i++) {
        r->targets[i].image = handles[i];
        r->image_count = i + 1;
        if (!create_target(r, failure, &r->targets[i]))
            return false;
    }

    write_word(r, ML_TARGET_WIDTH, r->extent.width);
    write_word(r, ML_TARGET_HEIGHT, r->extent.height);
    write_word(r, ML_TARGET_BACKING_WIDTH, r->extent.width);
    write_word(r, ML_TARGET_BACKING_HEIGHT, r->extent.height);
    moonlightRendererLogf(r, "renderer.swapchain: %ux%u format=%d images=%u fifo",
        r->extent.width, r->extent.height, r->format.format, count);
    return true;
}

#ifdef MOONLIGHT_RENDERER_TEST
static MoonlightBuffer readback_buffer;

MoonlightRenderResult moonlightRendererReadback(MoonlightRenderer *r, uint8_t *rgba, size_t bytes)
{
    const size_t needed = (size_t)r->extent.width * r->extent.height * 4;
    if (bytes < needed || !readback_buffer.mapped)
        return MOONLIGHT_RENDER_INVALID;
    if (vkDeviceWaitIdle(r->device) != VK_SUCCESS)
        return MOONLIGHT_RENDER_DEVICE;

    memcpy(rgba, readback_buffer.mapped, needed);
    return MOONLIGHT_RENDER_OK;
}

static void record_readback(MoonlightRenderer *r, VkCommandBuffer command, VkImage image)
{
    if (!readback_buffer.buffer) {
        Failure ignored;
        const VkDeviceSize size = (VkDeviceSize)r->extent.width * r->extent.height * 4;
        if (!create_buffer(r, &ignored, &readback_buffer, size, VK_BUFFER_USAGE_TRANSFER_DST_BIT, "readback"))
            return;
    }

    const VkBufferImageCopy region = {
        .imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1},
        .imageExtent = {r->extent.width, r->extent.height, 1},
    };
    vkCmdCopyImageToBuffer(command, image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, readback_buffer.buffer, 1, &region);
    const VkImageMemoryBarrier present = {
        .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_TRANSFER_READ_BIT,
        .oldLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
        .newLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR,
        .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .image = image,
        .subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1},
    };
    const VkMemoryBarrier host = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
        .dstAccessMask = VK_ACCESS_HOST_READ_BIT,
    };
    vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_TRANSFER_BIT,
        VK_PIPELINE_STAGE_HOST_BIT | VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, 0, 1, &host, 0, NULL, 1, &present);
}

static void destroy_readback(MoonlightRenderer *r)
{
    if (r->device)
        destroy_buffer(r, &readback_buffer);
}
#else
static void destroy_readback(MoonlightRenderer *r)
{
    (void)r;
}
#endif

static void retire(MoonlightRenderer *r, MoonlightFlight *flight)
{
    if (!flight->pending)
        return;

    vkResetFences(r->device, 1, &flight->fence);
    if (flight->slot != ML_NO_SLOT)
        r->slot_readers[flight->slot]--;
    flight->slot = ML_NO_SLOT;
    flight->pending = false;
}

static MoonlightRenderResult wait_flight(MoonlightRenderer *r, MoonlightFlight *flight, uint64_t timeout_ns)
{
    if (!flight->pending)
        return MOONLIGHT_RENDER_OK;

    const uint64_t started = moonlightNowNs();
    VkResult rc = VK_SUCCESS;
#ifdef MOONLIGHT_RENDERER_TEST
    moonlight_renderer_test_fence_waits++;
    if (moonlight_renderer_test_fence_timeout)
        return MOONLIGHT_RENDER_BUSY;
#endif
    if (timeout_ns)
        rc = vkWaitForFences(r->device, 1, &flight->fence, VK_TRUE, timeout_ns);
    else
        rc = vkGetFenceStatus(r->device, flight->fence);
    timing_add(&r->fence, started);
    if (rc == VK_ERROR_DEVICE_LOST)
        r->lost = true;
    if (rc != VK_SUCCESS)
        return from_vk(rc);

    retire(r, flight);
    return MOONLIGHT_RENDER_OK;
}

static MoonlightRenderResult wait_all(MoonlightRenderer *r)
{
    for (uint32_t i = 0; i < ML_FRAMES_IN_FLIGHT; i++) {
        MoonlightRenderResult result = wait_flight(r, &r->flights[i], ML_WAIT_NS);
        if (result != MOONLIGHT_RENDER_OK)
            return result;
    }
    return MOONLIGHT_RENDER_OK;
}

static MoonlightRenderResult rebuild_swapchain(MoonlightRenderer *r)
{
    MoonlightRenderResult result = wait_all(r);
    if (result != MOONLIGHT_RENDER_OK)
        return result;

    destroy_targets(r);
    destroy_readback(r);
    Failure failure = {MOONLIGHT_RENDER_OK, NULL};
    if (!create_swapchain(r, &failure)) {
        destroy_targets(r);
        return failure.result;
    }

    r->rebuild = false;
    r->swapchain_rebuilds++;
    return MOONLIGHT_RENDER_OK;
}

static void memory_barrier(VkCommandBuffer command, VkPipelineStageFlags src_stage, VkAccessFlags src_access,
    VkPipelineStageFlags dst_stage, VkAccessFlags dst_access)
{
    const VkMemoryBarrier barrier = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = src_access,
        .dstAccessMask = dst_access,
    };
    vkCmdPipelineBarrier(command, src_stage, dst_stage, 0, 1, &barrier, 0, NULL, 0, NULL);
}

static void record_compute(MoonlightRenderer *r, VkCommandBuffer command)
{
    const VkPipelineStageFlags graphics = VK_PIPELINE_STAGE_VERTEX_SHADER_BIT | VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT;
    const VkAccessFlags rw = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT;

    memory_barrier(command, graphics | VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, rw, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, rw);
    vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE, r->pipeline_layout, 0, 1, &r->set, 0, NULL);
    vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, r->compute);
    vkCmdDispatch(command, 1, 1, 1);
    memory_barrier(command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_WRITE_BIT, graphics,
        VK_ACCESS_SHADER_READ_BIT);
}

static VkResult record(MoonlightRenderer *r, VkCommandBuffer command, uint32_t image, MoonlightPresentMode mode)
{
    const bool interactive = mode == MOONLIGHT_PRESENT_INTERACTIVE;
    const VkCommandBufferBeginInfo begin = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
        .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT,
    };
    VkResult rc = vkResetCommandBuffer(command, 0);
    if (rc == VK_SUCCESS)
        rc = vkBeginCommandBuffer(command, &begin);
    if (rc != VK_SUCCESS)
        return rc;

    if (interactive)
        record_compute(r, command);
    vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_GRAPHICS, r->pipeline_layout, 0, 1, &r->set, 0, NULL);

    const VkClearValue clear = {.color = {.float32 = {ML_CLEAR_RED, ML_CLEAR_GREEN, ML_CLEAR_BLUE, 1.0f}}};
    const VkRenderPassBeginInfo pass = {
        .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO,
        .renderPass = r->render_pass,
        .framebuffer = r->targets[image].framebuffer,
        .renderArea = {{0, 0}, r->extent},
        .clearValueCount = 1,
        .pClearValues = &clear,
    };
    vkCmdBeginRenderPass(command, &pass, VK_SUBPASS_CONTENTS_INLINE);
    const VkViewport viewport = {0, 0, (float)r->extent.width, (float)r->extent.height, 0, 1};
    const VkRect2D scissor = {{0, 0}, r->extent};
    vkCmdSetViewport(command, 0, 1, &viewport);
    vkCmdSetScissor(command, 0, 1, &scissor);

    if (r->current_slot != ML_NO_SLOT) {
        vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_GRAPHICS, r->video);
        vkCmdDraw(command, 3, 1, 0, r->current_slot);
    }
    vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_GRAPHICS, r->ui);
    if (interactive)
        vkCmdDraw(command, 6, ML_UI_INSTANCES + 1, 0, 0);
    else
        vkCmdDraw(command, 6, 1, 0, ML_BADGE_INSTANCE);
    vkCmdEndRenderPass(command);

    if (interactive) {
        memory_barrier(command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_WRITE_BIT,
            VK_PIPELINE_STAGE_HOST_BIT, VK_ACCESS_HOST_READ_BIT);
    }
#ifdef MOONLIGHT_RENDERER_TEST
    record_readback(r, command, r->targets[image].image);
#endif
    return vkEndCommandBuffer(command);
}

static bool gpu_finished(MoonlightRenderer *r)
{
    if (!r->device || r->lost)
        return true;

    const MoonlightRenderResult result = wait_all(r);
    return result == MOONLIGHT_RENDER_OK || r->lost;
}

static bool destroy_objects(MoonlightRenderer *r)
{
    if (!gpu_finished(r)) {
        moonlightRendererLogf(r, "renderer.teardown: GPU work outstanding, keeping device, swapchain and layer");
        return false;
    }
    if (r->lost)
        moonlightRendererLogf(r, "renderer.teardown: device lost, releasing");

    if (r->device) {
        close_pipeline_cache(r);
        destroy_readback(r);
        destroy_targets(r);
        if (r->swapchain)
            vkDestroySwapchainKHR(r->device, r->swapchain, r->allocator);
        for (uint32_t i = 0; i < ML_FRAMES_IN_FLIGHT; i++) {
            MoonlightFlight *flight = &r->flights[i];
            if (flight->fence)
                vkDestroyFence(r->device, flight->fence, r->allocator);
            if (flight->acquired)
                vkDestroySemaphore(r->device, flight->acquired, r->allocator);
        }
        if (r->command_pool)
            vkDestroyCommandPool(r->device, r->command_pool, r->allocator);
        if (r->compute)
            vkDestroyPipeline(r->device, r->compute, r->allocator);
        if (r->video)
            vkDestroyPipeline(r->device, r->video, r->allocator);
        if (r->ui)
            vkDestroyPipeline(r->device, r->ui, r->allocator);
        if (r->render_pass)
            vkDestroyRenderPass(r->device, r->render_pass, r->allocator);
        if (r->pipeline_layout)
            vkDestroyPipelineLayout(r->device, r->pipeline_layout, r->allocator);
        if (r->descriptor_pool)
            vkDestroyDescriptorPool(r->device, r->descriptor_pool, r->allocator);
        if (r->set_layout)
            vkDestroyDescriptorSetLayout(r->device, r->set_layout, r->allocator);
        for (int plane = 0; plane < 2; plane++) {
            if (r->texel_views[plane])
                vkDestroyBufferView(r->device, r->texel_views[plane], r->allocator);
        }
        destroy_buffer(r, &r->storage);
        destroy_buffer(r, &r->input);
        vkDestroyDevice(r->device, r->allocator);
        moonlightRendererLogf(r, "renderer.teardown: device released");
    }

    const bool surface = r->surface != VK_NULL_HANDLE;
    if (surface)
        vkDestroySurfaceKHR(r->instance, r->surface, r->allocator);
    if (r->instance)
        vkDestroyInstance(r->instance, r->allocator);
    if (surface)
        moonlightRendererLogf(r, "renderer.teardown: layer released 0x%08x", moonlightSurfaceRelease());
    return true;
}

typedef struct {
    const char *name;
    bool (*run)(MoonlightRenderer *r, Failure *failure);
} Stage;

static const Stage STAGES[] = {
    {"instance", create_instance},
    {"physical", choose_physical},
    {"device", create_device},
    {"limits", choose_video_path},
    {"buffers", create_buffers},
    {"set", create_set},
    {"format", choose_format},
    {"render-pass", create_render_pass},
    {"pipelines", create_pipelines},
    {"frames", create_flights},
    {"swapchain", create_swapchain},
};

static bool valid_config(const MoonlightRendererConfig *config)
{
    if (!config)
        return false;
    return config->width == ML_WIDTH && config->height == ML_HEIGHT;
}

MoonlightRenderResult moonlightRendererCreate(const MoonlightRendererConfig *config,
    MoonlightRendererLog log, MoonlightRenderer **out)
{
    if (!out)
        return MOONLIGHT_RENDER_INVALID;
    *out = NULL;
    if (!valid_config(config))
        return MOONLIGHT_RENDER_UNSUPPORTED;
    if (open_renderer)
        return open_renderer->retained ? MOONLIGHT_RENDER_RETAINED : MOONLIGHT_RENDER_BUSY;

    MoonlightRenderer *r = calloc(1, sizeof(*r));
    if (!r)
        return MOONLIGHT_RENDER_NO_MEMORY;

    r->log = log;
    r->config = *config;
    r->current_slot = ML_NO_SLOT;
#ifdef MOONLIGHT_RENDERER_TEST
    moonlight_renderer_calls = 0;
    r->allocator = moonlight_renderer_test_allocator;
#endif

    const uint64_t started = moonlightNowNs();
    Failure failure = {MOONLIGHT_RENDER_OK, NULL};
    for (size_t i = 0; i < sizeof(STAGES) / sizeof(STAGES[0]); i++) {
        const uint64_t stage_started = moonlightNowNs();
        if (!STAGES[i].run(r, &failure)) {
            moonlightRendererLogf(r, "renderer.create: failed in %s at %s (%s)", STAGES[i].name, failure.what,
                moonlightRenderResultName(failure.result));
            if (!destroy_objects(r)) {
                r->retained = true;
                open_renderer = r;
                return MOONLIGHT_RENDER_RETAINED;
            }
            free(r);
            return failure.result;
        }
        moonlightRendererLogf(r, "renderer.start: %s %llu us", STAGES[i].name,
            (unsigned long long)((moonlightNowNs() - stage_started) / 1000));
    }

    r->startup_ns = moonlightNowNs() - started;
    moonlightRendererLogf(r, "renderer.start: ready %llu us", (unsigned long long)(r->startup_ns / 1000));
    open_renderer = r;
    *out = r;
    return MOONLIGHT_RENDER_OK;
}

MoonlightRenderResult moonlightRendererCollect(MoonlightRenderer *r, uint64_t timeout_ns)
{
    if (!r)
        return MOONLIGHT_RENDER_INVALID;

    for (uint32_t i = 0; i < ML_FRAMES_IN_FLIGHT; i++)
        wait_flight(r, &r->flights[i], timeout_ns);
    if (r->lost)
        return MOONLIGHT_RENDER_LOST;

    for (uint32_t slot = 0; slot < ML_VIDEO_SLOTS; slot++) {
        if (slot != r->current_slot && r->slot_readers[slot] == 0)
            return MOONLIGHT_RENDER_OK;
    }
    return MOONLIGHT_RENDER_BUSY;
}

static uint32_t free_slot(const MoonlightRenderer *r)
{
    for (uint32_t slot = 0; slot < ML_VIDEO_SLOTS; slot++) {
        if (slot != r->current_slot && r->slot_readers[slot] == 0)
            return slot;
    }
    return ML_NO_SLOT;
}

static uint32_t wait_for_slot(MoonlightRenderer *r)
{
    const uint64_t entered = moonlightNowNs();
    uint64_t budget = (uint64_t)r->config.upload_wait_us * 1000u;
    for (uint32_t i = 0; i < ML_FRAMES_IN_FLIGHT && budget; i++) {
        MoonlightFlight *flight = &r->flights[i];
        if (!flight->pending || flight->slot == r->current_slot || flight->slot == ML_NO_SLOT)
            continue;
        const uint64_t started = moonlightNowNs();
        wait_flight(r, flight, budget);
        const uint64_t spent = moonlightNowNs() - started;
        budget = spent < budget ? budget - spent : 0;
    }
    timing_add(&r->upload_wait, entered);
    return free_slot(r);
}

MoonlightRenderResult moonlightRendererUpload(MoonlightRenderer *r, const MoonlightNv12Frame *frame, uint32_t *slot)
{
    if (!r)
        return MOONLIGHT_RENDER_INVALID;

    MoonlightSlotLayout layout;
    MoonlightRenderResult result = moonlightFramePlan(frame, &layout);
    if (result != MOONLIGHT_RENDER_OK)
        return result;

    result = moonlightRendererCollect(r, 0);
    if (result == MOONLIGHT_RENDER_LOST)
        return result;

    uint32_t target = free_slot(r);
    if (target == ML_NO_SLOT && r->config.upload_wait_us && !r->lost)
        target = wait_for_slot(r);
    if (target == ML_NO_SLOT) {
        r->busy_uploads++;
        return MOONLIGHT_RENDER_BUSY;
    }

    const uint64_t started = moonlightNowNs();
    moonlightFrameCopy(frame, &layout, r->storage.mapped + mlFrameOffset(target));
    r->sequence++;
    if (r->sequence == 0)
        r->sequence = 1;
    moonlightFramePublish(r->storage.mapped, target, &layout, r->sequence);
    timing_add(&r->upload, started);
    r->current_slot = target;
    if (slot)
        *slot = target;
    return MOONLIGHT_RENDER_OK;
}

static MoonlightRenderResult acquire(MoonlightRenderer *r, MoonlightFlight *flight, uint32_t *image)
{
    const uint64_t started = moonlightNowNs();
    VkResult rc = vkAcquireNextImageKHR(r->device, r->swapchain, ML_WAIT_NS, flight->acquired, VK_NULL_HANDLE, image);
    timing_add(&r->acquire, started);
    if (rc == VK_SUBOPTIMAL_KHR) {
        r->rebuild = true;
        return MOONLIGHT_RENDER_OK;
    }
    if (rc == VK_ERROR_OUT_OF_DATE_KHR) {
        r->rebuild = true;
        return MOONLIGHT_RENDER_BUSY;
    }
    if (rc == VK_ERROR_DEVICE_LOST)
        r->lost = true;
    return from_vk(rc);
}

static MoonlightRenderResult submit(MoonlightRenderer *r, MoonlightFlight *flight, uint32_t image)
{
    const VkPipelineStageFlags stage = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    const VkSubmitInfo info = {
        .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
        .waitSemaphoreCount = 1,
        .pWaitSemaphores = &flight->acquired,
        .pWaitDstStageMask = &stage,
        .commandBufferCount = 1,
        .pCommandBuffers = &flight->command,
        .signalSemaphoreCount = 1,
        .pSignalSemaphores = &r->targets[image].rendered,
    };
    VkResult rc = vkQueueSubmit(r->queue, 1, &info, flight->fence);
    if (rc != VK_SUCCESS) {
        r->lost = true;
        moonlightRendererLogf(r, "renderer.submit: failed (%d)", rc);
        return from_vk(rc);
    }

    flight->pending = true;
    flight->slot = r->current_slot;
    if (flight->slot != ML_NO_SLOT)
        r->slot_readers[flight->slot]++;
    return MOONLIGHT_RENDER_OK;
}

static MoonlightRenderResult present(MoonlightRenderer *r, uint32_t image)
{
    const VkPresentInfoKHR info = {
        .sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR,
        .waitSemaphoreCount = 1,
        .pWaitSemaphores = &r->targets[image].rendered,
        .swapchainCount = 1,
        .pSwapchains = &r->swapchain,
        .pImageIndices = &image,
    };
    const uint64_t started = moonlightNowNs();
    VkResult rc = vkQueuePresentKHR(r->queue, &info);
    timing_add(&r->present, started);
    if (rc == VK_SUBOPTIMAL_KHR || rc == VK_ERROR_OUT_OF_DATE_KHR) {
        r->rebuild = true;
        return MOONLIGHT_RENDER_OK;
    }
    if (rc == VK_ERROR_DEVICE_LOST)
        r->lost = true;
    return from_vk(rc);
}

MoonlightRenderResult moonlightRendererPresent(MoonlightRenderer *r, MoonlightPresentMode mode)
{
    if (!r)
        return MOONLIGHT_RENDER_INVALID;
    if (mode != MOONLIGHT_PRESENT_STREAMING && mode != MOONLIGHT_PRESENT_INTERACTIVE)
        return MOONLIGHT_RENDER_INVALID;
    if (r->lost)
        return MOONLIGHT_RENDER_LOST;

    MoonlightRenderResult result = MOONLIGHT_RENDER_OK;
    if (r->rebuild || !r->swapchain)
        result = rebuild_swapchain(r);
    if (result != MOONLIGHT_RENDER_OK)
        return result;

    MoonlightFlight *flight = &r->flights[r->next_flight];
    result = wait_flight(r, flight, ML_WAIT_NS);
    if (result != MOONLIGHT_RENDER_OK)
        return r->lost ? MOONLIGHT_RENDER_LOST : result;

    uint32_t image = 0;
    result = acquire(r, flight, &image);
    if (result != MOONLIGHT_RENDER_OK)
        return result;

    const uint64_t started = moonlightNowNs();
    VkResult rc = record(r, flight->command, image, mode);
    if (rc != VK_SUCCESS) {
        r->lost = true;
        moonlightRendererLogf(r, "renderer.record: failed (%d)", rc);
        return from_vk(rc);
    }

    result = submit(r, flight, image);
    timing_add(&r->submit, started);
    if (result != MOONLIGHT_RENDER_OK)
        return result;

    r->next_flight = (r->next_flight + 1) % ML_FRAMES_IN_FLIGHT;
    r->last_image = image;
    r->presented++;
    return present(r, image);
}

uint8_t *moonlightRendererStorage(MoonlightRenderer *r, size_t *bytes)
{
    if (bytes)
        *bytes = r ? ML_STORAGE_BYTES : 0;
    return r ? r->storage.mapped : NULL;
}

uint8_t *moonlightRendererInput(MoonlightRenderer *r, size_t *bytes)
{
    if (bytes)
        *bytes = r ? ML_INPUT_BYTES : 0;
    return r ? r->input.mapped : NULL;
}

void moonlightRendererGetInfo(const MoonlightRenderer *r, MoonlightRendererInfo *info)
{
    if (!info)
        return;
    *info = (MoonlightRendererInfo){0};
    if (!r)
        return;

    *info = (MoonlightRendererInfo){
        .width = r->extent.width,
        .height = r->extent.height,
        .swapchain_images = r->image_count,
        .surface_format = (uint32_t)r->format.format,
        .video_path = r->video_path,
        .presented = r->presented,
        .busy_uploads = r->busy_uploads,
        .swapchain_rebuilds = r->swapchain_rebuilds,
        .pipeline_cache = r->cache_state,
        .pipeline_cache_saved = r->cache_saved,
        .startup_ns = r->startup_ns,
        .upload = r->upload,
        .acquire = r->acquire,
        .submit = r->submit,
        .fence = r->fence,
        .present = r->present,
        .upload_wait = r->upload_wait,
    };
}

MoonlightRenderResult moonlightRendererClose(MoonlightRenderer *r)
{
    if (!r || r != open_renderer)
        return MOONLIGHT_RENDER_INVALID;
    if (r->retained)
        return MOONLIGHT_RENDER_RETAINED;

    if (!destroy_objects(r)) {
        r->retained = true;
        moonlightRendererLogf(r, "renderer.close: retained, no further renderer in this process");
        return MOONLIGHT_RENDER_RETAINED;
    }

    const bool lost = r->lost;
    open_renderer = NULL;
    free(r);
    return lost ? MOONLIGHT_RENDER_LOST : MOONLIGHT_RENDER_OK;
}

MoonlightRenderer *moonlightRendererRetained(void)
{
    return open_renderer && open_renderer->retained ? open_renderer : NULL;
}

void moonlightRendererDestroy(MoonlightRenderer *r)
{
    moonlightRendererClose(r);
}
