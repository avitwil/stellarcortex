// This function is also supplied verbatim to Codex's sandboxed functions.exec.
// The pinned runtime flattens dynamic tool contentItems into a newline string.
// Native images require image(...), never text(...) around the whole result.
export function showVisualResult(result) {
  const emit = value => {
    if (typeof value === 'string') {
      for (const line of value.split('\n')) {
        if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(line)) image(line);
        else if (line.startsWith('data:image/'))
          throw Error('Unsupported image encoding; do not print image bytes as text.');
        else if (line) text(line);
      }
    } else if (Array.isArray(value)) value.forEach(emit);
    else if (value?.type === 'inputImage' && typeof value.imageUrl === 'string')
      image(value.imageUrl);
    else if (value?.type === 'image' && value.data && value.mimeType) image(value);
    else if (value?.type === 'inputText' || value?.type === 'text') emit(value.text);
    else if (value?.contentItems) emit(value.contentItems);
    else if (value?.content) emit(value.content);
    else throw Error('Unsupported visual result shape; do not stringify image-bearing results.');
  };
  emit(result);
}
export const CODEX_VISUAL_TOOL_HINT =
  'This tool can return images. In functions.exec use showVisualResult(await tools.TOOL_NAME(args)) with the helper supplied in developer instructions. Never text(...) or JSON.stringify(...) the full image-bearing result; that turns images into truncated base64 text.';
export const CODEX_VISUAL_INSTRUCTIONS = `Visual tool results from stellarcortex_computer, stellarcortex_browser and stellarcortex_skill may contain screenshots or reviewed examples. The installed Codex exec wrapper returns dynamic-tool results as text plus data-image URL lines, even though the client supplied inputImage content. Forward every image through image(...), and only metadata through text(...). Define this helper inside the same functions.exec cell, then call showVisualResult(await tools.stellarcortex_computer({action:"screenshot"})) or showVisualResult(await tools.stellarcortex_skill({action:"read",skillId:"the observed ID"})). Do not print raw image URLs or infer an image was seen from metadata. This is rendering of already returned data, not permission for another tool call.\n\n${showVisualResult.toString()}`;
