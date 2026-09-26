/**
 * ONVIF onboarding close: Review confirm, then Success.
 *
 * Both steps read the saved non-secret camera row. They do not call the
 * device, do not read stored login, and do not open a stream. A camera can
 * be reviewed only when it is configured and the last test summary is
 * passed. Success then marks that camera ready for a later Live View unit.
 */

const REVIEW_CONTRACT = 'onvif.review.v0';
const SUCCESS_CONTRACT = 'onvif.success.v0';

export function reviewContract() {
  return REVIEW_CONTRACT;
}

export function successContract() {
  return SUCCESS_CONTRACT;
}

export function publicReviewPayload(outcome) {
  return publicStepPayload(REVIEW_CONTRACT, outcome, new Set(['not_found', 'not_tested', 'test_failed']));
}

export function publicSuccessPayload(outcome) {
  return publicStepPayload(
    SUCCESS_CONTRACT,
    outcome,
    new Set(['not_found', 'not_tested', 'test_failed', 'not_reviewed'])
  );
}

function publicStepPayload(contract, outcome, errors) {
  if (!outcome || outcome.error) {
    const error = outcome && errors.has(outcome.error) ? outcome.error : 'not_tested';
    return {
      status: error === 'not_found' ? 404 : 409,
      body: {
        ok: false,
        contract,
        error
      }
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      contract,
      camera: outcome.camera
    }
  };
}
