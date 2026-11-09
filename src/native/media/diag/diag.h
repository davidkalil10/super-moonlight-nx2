#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "../../audio.h"
#include "../../media.h"

/* Bounded media/audio diagnostic: known video records and quiet PCM from the host fixture.
 * Contract: moonlight-nx2-dev/src/native/media/diag/README.md. */

#define MEDIA_DIAG_SESSION_MAX_BYTES 1024u

typedef struct {
    uint8_t address[4];
    uint16_t video_port;
    uint16_t audio_port;
    char video_token[MOONLIGHT_MEDIA_TOKEN_BYTES];
    char audio_token[MOONLIGHT_MEDIA_TOKEN_BYTES];
} MediaDiagSession;

typedef enum {
    MEDIA_DIAG_SESSION_OK = 0,
    MEDIA_DIAG_SESSION_MISSING,
    MEDIA_DIAG_SESSION_MALFORMED,
    MEDIA_DIAG_SESSION_NOT_REMOVED,
} MediaDiagSessionResult;

typedef struct {
    uint64_t (*now_ms)(void);
    void (*idle)(void);
    void (*log)(const char *message);
    uint32_t connect_timeout_ms;
    uint32_t deadline_ms;
} MediaDiagEnv;

typedef struct {
    uint32_t video_records;
    uint32_t video_mismatches;
    MoonlightMediaResult video_result;
    MoonlightMediaResult video_close;
    MoonlightMediaStats video_stats;

    uint32_t pcm_records;
    uint32_t pcm_mismatches;
    MoonlightMediaResult pcm_result;
    MoonlightMediaResult pcm_close;
    MoonlightMediaStats pcm_stats;

    MoonlightAudioResult audio_result;
    MoonlightAudioResult audio_close;
    MoonlightAudioStats audio_stats;
    bool audio_retired;

    bool deadline_hit;
    uint64_t elapsed_ms;
    bool pass;
} MediaDiagReport;

/* Reads the one-time session file, overwrites it with zeros and removes it. On any result
 * other than OK the session is wiped and must not be used. */
MediaDiagSessionResult mediaDiagReadSession(const char *path, MediaDiagSession *session);

const char *mediaDiagSessionResultName(MediaDiagSessionResult result);

/* Streams both channels until the host ends them or the deadline passes, then closes the
 * channels and `audio`, which the caller opened and hands over. Wipes the session tokens. */
void mediaDiagRun(MediaDiagSession *session, MoonlightAudio *audio, const MediaDiagEnv *env,
                  MediaDiagReport *report);

void mediaDiagLogReport(const MediaDiagReport *report, void (*log)(const char *message));
