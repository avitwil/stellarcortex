export function frameRedactionPlan({ width, height, crop, masks = [] }) {
  const rect = r => {
    if (
      !r ||
      !['x', 'y', 'width', 'height'].every(k => Number.isInteger(r[k])) ||
      r.x < 0 ||
      r.y < 0 ||
      r.width < 1 ||
      r.height < 1 ||
      r.x + r.width > width ||
      r.y + r.height > height
    )
      throw Error('Redaction rectangle must be inside the guest frame');
    return r;
  };
  rect({ x: 0, y: 0, width, height });
  const region = rect(crop);
  if (!Array.isArray(masks) || masks.length > 100)
    throw Error('Bounded explicit mask list required');
  const args = ['jpeg:-'];
  for (const mask of masks) {
    const m = rect(mask);
    args.push(
      '-fill',
      '#000000',
      '-draw',
      `rectangle ${m.x},${m.y} ${m.x + m.width - 1},${m.y + m.height - 1}`,
    );
  }
  args.push(
    '-crop',
    `${region.width}x${region.height}+${region.x}+${region.y}`,
    '+repage',
    '-strip',
    '-quality',
    '70',
    'jpeg:-',
  );
  return args;
}
