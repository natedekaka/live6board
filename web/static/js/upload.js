/** Unggah gambar ke server dan terima blok gambar yang dihasilkan. */

export async function uploadImage({ file, room, afterId = null, alt = "" }) {
  const form = new FormData();
  form.append("file", file);
  if (afterId) form.append("afterId", afterId);
  if (alt) form.append("alt", alt);

  const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/images`, {
    method: "POST",
    body: form,
  });

  let detail = "Gagal mengunggah gambar.";
  if (response.ok) {
    const data = await response.json();
    return data;
  } else {
    try {
      const body = await response.json();
      detail = body.detail || detail;
    } catch {
      /* gunakan detail default */
    }
  }
  throw new Error(detail);
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Gagal membaca berkas."));
    reader.readAsDataURL(file);
  });
}
