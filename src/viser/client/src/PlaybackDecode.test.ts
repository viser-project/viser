import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  decompressAndDecodeHybridPayload,
  SerializedMessages,
} from "./PlaybackDecode";
import { MeshMessage } from "./WebsocketMessages";

// A real `.viser` payload produced by the Python server, exercising the full
// encode -> decode contract (zstd framing, msgpack header, aligned binary
// buffers, placeholder replacement, and buffer deduplication). Regenerate
// with:
//
//   import base64, numpy as np, viser
//   server = viser.ViserServer(port=0, verbose=False)
//   verts = np.array(
//       [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float32)
//   faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.uint32)
//   server.scene.add_mesh_simple("/fixture_a", verts.copy(), faces.copy())
//   server.scene.add_mesh_simple("/fixture_b", verts.copy(), faces.copy())
//   s = server.get_scene_serializer()
//   s.insert_sleep(0.25)
//   print(base64.b64encode(s.serialize()).decode())
const FIXTURE_B64 = [
  "mAQAAAAAAAAotS/9YJgDRQ8AZtlaPkBtmwPGh6dv5gVOC6ZVnmdenq0fF58wZ0TEPd8MLrdo2xI5",
  "AxHZCLmJTCKnWYvDeds3o/35VANWFRZlrmplSgBKAEwAGrOndtphg4aFp3us4/qJp6PqNLmKMpzn",
  "bKMLpd6jwl/Ur+05QxArpw4IfLC1E0PhdRkanqf9Z4t7JZ7u46SQoUm7rmPRA8YTUAmWgjgx6hME",
  "uJUQVL04foRs3RhJk3PTvDbqWk4lB4ZWu+oLjpQBT4ZQZUjEhiupvy0dFmytJ9DwpVUMiqfjauFv",
  "T6Qj0sHgtKJQEx/VraQmRKsN96IdG8neF4+RDonOg60Ck6zcKuSBjbi9jOPsSPOdLUURyIRn2NXZ",
  "wl3YiB2rWcs6ub1BZQhEihETIzpJhghadsFwmDbvvQAAJI+EN4CS8QucpcQqHygGJpRJAY5J+50v",
  "nL8tGkniUM8WGbY0Q3YQzoX+wkz0jXPrc9W2c12Lq5O63Dj2YzbT7LhUMyBggkFFVTcM/LoCPBZ2",
  "j2FUavK5ph8Dh3nrHFGsFDEzfO3XyuPKzw1DxHcHUrtqyIb1fB5T4hKkaWtwihwO/YJOHWrVl1nI",
  "iCgH2HAeEiQMyUBJF4t/yArn7TGVI1xJAZyEk8iDnQ+DqVVEoXEj7BzEFJ7nX2MCHwI=",
].join("");

const EXPECTED_VERTICES = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const EXPECTED_FACES = [0, 1, 2, 0, 2, 3];

async function decodeFixture(): Promise<SerializedMessages> {
  const bytes = base64ToBytes(FIXTURE_B64);
  return await decompressAndDecodeHybridPayload<SerializedMessages>(bytes);
}

function meshesOf(recording: SerializedMessages): MeshMessage[] {
  return recording.messages
    .map(([, message]) => message)
    .filter((message): message is MeshMessage => {
      return message.type === "MeshMessage";
    });
}

describe("PlaybackDecode", () => {
  it("decodes a Python-serialized recording", async () => {
    const recording = await decodeFixture();

    expect(recording.durationSeconds).toBe(0.25);
    expect(typeof recording.viserVersion).toBe("string");

    const meshes = meshesOf(recording);
    expect(meshes.map((m) => m.name).sort()).toEqual([
      "/fixture_a",
      "/fixture_b",
    ]);

    for (const mesh of meshes) {
      expect(mesh.props.vertices).toBeInstanceOf(Float32Array);
      expect(Array.from(mesh.props.vertices)).toEqual(EXPECTED_VERTICES);
      expect(mesh.props.faces).toBeInstanceOf(Uint32Array);
      expect(Array.from(mesh.props.faces)).toEqual(EXPECTED_FACES);
    }
  });

  it("resolves deduplicated buffers to shared byte ranges", async () => {
    const recording = await decodeFixture();
    const meshes = meshesOf(recording);
    expect(meshes.length).toBe(2);

    // The server stores byte-identical arrays once; both messages' views must
    // alias the same region of the shared ArrayBuffer (while remaining
    // distinct view objects).
    const [a, b] = meshes;
    expect(a.props.vertices).not.toBe(b.props.vertices);
    expect(a.props.vertices.buffer).toBe(b.props.vertices.buffer);
    expect(a.props.vertices.byteOffset).toBe(b.props.vertices.byteOffset);
    expect(a.props.faces.byteOffset).toBe(b.props.faces.byteOffset);
    // Vertices and faces are different content, so they must NOT alias.
    expect(a.props.vertices.byteOffset).not.toBe(a.props.faces.byteOffset);
  });

  it("decodes base64 identically with and without native fromBase64", () => {
    const uint8ArrayStatics = Uint8Array as unknown as {
      fromBase64?: (data: string) => Uint8Array;
    };
    const original = uint8ArrayStatics.fromBase64;
    try {
      // Exercise the native branch even on runtimes without fromBase64, by
      // shimming it (Buffer is the Node-native reference decoder).
      uint8ArrayStatics.fromBase64 ??= (data) =>
        new Uint8Array(Buffer.from(data, "base64"));
      const native = base64ToBytes(FIXTURE_B64);

      // Exercise the real atob fallback branch by hiding the native method.
      uint8ArrayStatics.fromBase64 = undefined;
      const fallback = base64ToBytes(FIXTURE_B64);

      expect(Array.from(fallback)).toEqual(Array.from(native));
    } finally {
      uint8ArrayStatics.fromBase64 = original;
    }
  });
});
