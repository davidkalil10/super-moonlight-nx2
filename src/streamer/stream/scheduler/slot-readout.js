/**
 * The decoder slot readout of HBL_STAGE_TICKS=1: the input and output buffer indices the status
 * reads show and the most each acquire reported remaining (research/2au-fact-sheet.md).
 */

/** One readout per staggered scheduler; observe() takes every gate's status reads. */
function create() {
  const input = {indices: new Set(), remainingMax: 0, noSlot: {}};
  const output = {indices: new Set(), remainingMax: 0};
  let noSlotSequence = 0;

  /** The tail AcquireInput of input `sequence`; a refusal counts once per sequence. */
  function seeInput({nextSlotStatus, nextIndex, remaining, sequence}) {
    if (sequence === 0) return;

    if (nextSlotStatus !== 0n) {
      if (sequence === noSlotSequence) return;
      noSlotSequence = sequence;
      const code = '0x' + nextSlotStatus.toString(16);
      input.noSlot[code] = (input.noSlot[code] || 0) + 1;
      return;
    }

    input.indices.add(nextIndex);
    input.remainingMax = Math.max(input.remainingMax, remaining);
  }

  function seeOutput({status, index, remaining, sequence}) {
    if (sequence === 0 || status !== 0n || index < 0) return;

    output.indices.add(index);
    output.remainingMax = Math.max(output.remainingMax, remaining);
  }

  /** @param {Set<number>} set */
  const sorted = set => [...set].sort((a, b) => a - b);

  return {
    /** @param {import('../worker/staggered-status.js').Snapshot} snapshot */
    observe(snapshot) {
      seeInput(snapshot.input);
      seeOutput(snapshot.acquire);
    },

    get summary() {
      return {
        input: {
          indices: sorted(input.indices),
          remainingMax: input.remainingMax,
          noSlot: {...input.noSlot}
        },
        output: {indices: sorted(output.indices), remainingMax: output.remainingMax}
      };
    }
  };
}

export {create};
