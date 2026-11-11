/*
 * The system software keyboard for typing on the PC. swkbdShow blocks until the applet closes,
 * so it runs on its own thread and the main loop keeps the stream, video and audio going.
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include <switch.h>

#define TEXT_BYTES 512
#define TEXT_CHARACTERS 80
#define STACK_BYTES 0x40000
#define PRIORITY 0x2C

enum { IDLE, OPEN, TYPED, ENDED };

static Thread worker;
static uint32_t state = IDLE;
static Result outcome;
static char text[TEXT_BYTES];
static char stack[STACK_BYTES] __attribute__((aligned(0x1000)));

static void run(void *argument)
{
    (void)argument;
    SwkbdConfig keyboard;
    Result result = swkbdCreate(&keyboard, 0);
    if (R_SUCCEEDED(result)) {
        swkbdConfigMakePresetDefault(&keyboard);
        swkbdConfigSetHeaderText(&keyboard, "Type on the PC");
        swkbdConfigSetOkButtonText(&keyboard, "Send");
        swkbdConfigSetStringLenMax(&keyboard, TEXT_CHARACTERS);
        swkbdConfigSetReturnButtonFlag(&keyboard, 1);
        result = swkbdShow(&keyboard, text, sizeof(text));
        swkbdClose(&keyboard);
    }
    outcome = result;
    __atomic_store_n(&state, R_SUCCEEDED(result) && text[0] ? TYPED : ENDED, __ATOMIC_RELEASE);
}

/* False while a keyboard is already up or the thread did not start. */
bool moonlightKeyboardOpen(void)
{
    if (__atomic_load_n(&state, __ATOMIC_ACQUIRE) != IDLE)
        return false;
    memset(text, 0, sizeof(text));
    outcome = 0;
    __atomic_store_n(&state, OPEN, __ATOMIC_RELEASE);
    if (R_FAILED(threadCreate(&worker, run, NULL, stack, STACK_BYTES, PRIORITY, -2)) ||
        R_FAILED(threadStart(&worker))) {
        __atomic_store_n(&state, IDLE, __ATOMIC_RELEASE);
        return false;
    }
    return true;
}

/* 0 none, 1 up, 2 typed (UTF-8 in out), 3 closed without text; `result` is the SDK result. */
uint32_t moonlightKeyboardPoll(uint8_t *out, size_t bytes, uint32_t *result)
{
    uint32_t now = __atomic_load_n(&state, __ATOMIC_ACQUIRE);
    if (now == IDLE)
        return 0;
    if (now == OPEN)
        return 1;
    threadWaitForExit(&worker);
    threadClose(&worker);
    *result = outcome;
    uint32_t answer = 3;
    if (now == TYPED && strlen(text) < bytes) {
        memcpy(out, text, strlen(text) + 1);
        answer = 2;
    }
    __atomic_store_n(&state, IDLE, __ATOMIC_RELEASE);
    return answer;
}
