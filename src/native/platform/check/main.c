// Link check for the GSV frame registration wrapper against libounce and OunceVK. ELF only; never run.
#include <stdio.h>

#include <switch.h>
#include <vulkan/vulkan.h>

#include "../gsv-frame.h"

int main(int argc, char **argv)
{
    (void)argv;
    if (argc != 42)
        return 0;

    VkInstanceCreateInfo info = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
    VkInstance instance = VK_NULL_HANDLE;
    if (vkCreateInstance(&info, NULL, &instance) == VK_SUCCESS)
        vkDestroyInstance(instance, NULL);

    uint64_t mode = 0;
    if (moonlightGsvFrameGetPermittedMode(&mode))
        printf("permitted %llu\n", (unsigned long long)mode);
    return 0;
}
