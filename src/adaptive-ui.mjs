import { availableModels, isCloudModel, localOcrConfigured, localVisionConfigured, modelIdentity, resolveImageMode } from './protocol.mjs';

const preferences = new Set(['automatic', 'direct', 'local-tool', 'local-ocr']);
const vision = model => model?.vision === true || (Array.isArray(model?.capabilities) && model.capabilities.includes('vision'));
const local = model => model && !isCloudModel(model) && model.local !== false && (model.provider || 'ollama') === 'ollama';
const result = (imageMode, reason) => Object.freeze({ imageMode, reason });

function currentSelection(model, capabilities) {
  if (typeof model?.name !== 'string' || !model.name || model.allowed === false || model.available === false || model.configured === false) {
    throw new Error('Choose an available model before sending images.');
  }
  if (!Array.isArray(capabilities?.models)) throw new Error('Refresh the Agent connection to check image handling for the selected model.');
  // Checking eligibility does not grant cloud opt-in. buildAgentRequest still
  // requires the existing explicit cloud permission, spending and policy checks.
  const current = availableModels(capabilities, true).find(candidate => modelIdentity(candidate) === modelIdentity(model));
  if (!current) throw new Error('The selected model is no longer available. Refresh the connection and choose an available model.');
  return current;
}

/**
 * Resolve only a NEW, unsent Agent request. Keep this UI preference separate
 * from the actual backend imageMode. Never apply it to retained request bytes,
 * run recovery or recorded settings. No providers, budgets or permissions change.
 */
export function resolveAdaptiveImageMode({ preference = 'automatic', model, capabilities, imageCount = 0 } = {}) {
  if (!preferences.has(preference)) throw new Error('Choose Automatic, Direct vision model, Local vision helper or Local OCR image handling.');
  if (!Number.isSafeInteger(imageCount) || imageCount < 0) throw new Error('The attached-image count is invalid. Review the attachments before sending.');

  if (preference !== 'automatic') {
    // Validate the explicit choice using the existing protocol contract; never
    // replace an unavailable manual helper with another route.
    resolveImageMode({ imageMode: preference, model, capabilities });
    if (imageCount > 0) {
      const current = currentSelection(model, capabilities);
      if (preference === 'direct' && !vision(current)) {
        throw new Error('Direct image handling requires the selected model to advertise vision. Choose Automatic or another image mode, choose a vision model, or remove the images.');
      }
    }
    return result(preference, 'Your explicit image-handling choice is preserved.');
  }

  if (imageCount === 0) return result('direct', 'No images are attached; no image helper is selected.');
  const current = currentSelection(model, capabilities);
  if (vision(current)) return result('direct', 'The selected model advertises image input; use it directly.');

  if (local(model) && local(current)) {
    if (localVisionConfigured(capabilities)) {
      resolveImageMode({ imageMode: 'local-tool', model, capabilities });
      return result('local-tool', 'Use the configured local vision helper with the selected local chat model.');
    }
    if (localOcrConfigured(capabilities)) {
      resolveImageMode({ imageMode: 'local-ocr', model, capabilities });
      return result('local-ocr', 'Use local English OCR with the selected local chat model; verify the extracted text against the image.');
    }
    throw new Error('This model does not advertise vision, and no local image helper is available. Configure local vision or English OCR, choose an available vision model, or remove the images.');
  }

  throw new Error('This selected model does not advertise vision. Choose an available vision model, explicitly choose a local Ollama model to use a configured local helper, or remove the images.');
}
