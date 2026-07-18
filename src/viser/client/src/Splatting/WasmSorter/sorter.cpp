#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <wasm_simd128.h>

#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

// Horizontal min across an f32x4 lane.
__attribute__((always_inline)) inline float hmin_f32x4(v128_t v) {
    float a = wasm_f32x4_extract_lane(v, 0);
    float b = wasm_f32x4_extract_lane(v, 1);
    float c = wasm_f32x4_extract_lane(v, 2);
    float d = wasm_f32x4_extract_lane(v, 3);
    return std::fmin(std::fmin(a, b), std::fmin(c, d));
}

// Horizontal max across an f32x4 lane.
__attribute__((always_inline)) inline float hmax_f32x4(v128_t v) {
    float a = wasm_f32x4_extract_lane(v, 0);
    float b = wasm_f32x4_extract_lane(v, 1);
    float c = wasm_f32x4_extract_lane(v, 2);
    float d = wasm_f32x4_extract_lane(v, 3);
    return std::fmax(std::fmax(a, b), std::fmax(c, d));
}

class Sorter {
    // Centers stored as structure-of-arrays (SoA), padded up to a multiple of
    // 4 so the SIMD depth loop can run without a scalar tail. Padding lanes
    // replicate the last real center so they never skew the depth min/max.
    std::vector<float> centers_x;
    std::vector<float> centers_y;
    std::vector<float> centers_z;
    std::vector<uint32_t> group_indices; // padded, length == padded_count.
    std::vector<uint32_t> sorted_indices;
    int32_t num_gaussians = 0;
    int32_t padded_count = 0; // num_gaussians rounded up to a multiple of 4.

  public:
    Sorter(
        const emscripten::val &buffer, const emscripten::val &group_indices_val
    ) {
        setBuffer(buffer, group_indices_val);
    };

    // Update the buffer and group indices. This allows dynamic updates without
    // recreating the sorter.
    void setBuffer(
        const emscripten::val &buffer, const emscripten::val &group_indices_val
    ) {
        const std::vector<uint32_t> bufferVec =
            emscripten::convertJSArrayToNumberVector<uint32_t>(buffer);
        const float *floatBuffer =
            reinterpret_cast<const float *>(bufferVec.data());
        num_gaussians = bufferVec.size() / 8;
        padded_count = ((num_gaussians + 3) / 4) * 4;

        sorted_indices.resize(num_gaussians);
        centers_x.resize(padded_count);
        centers_y.resize(padded_count);
        centers_z.resize(padded_count);
        for (int32_t i = 0; i < num_gaussians; i++) {
            centers_x[i] = floatBuffer[i * 8 + 0];
            centers_y[i] = floatBuffer[i * 8 + 1];
            centers_z[i] = floatBuffer[i * 8 + 2];
        }

        const std::vector<uint32_t> groupsIn =
            emscripten::convertJSArrayToNumberVector<uint32_t>(group_indices_val
            );
        group_indices.resize(padded_count);
        for (int32_t i = 0; i < num_gaussians; i++)
            group_indices[i] = groupsIn[i];

        // Replicate the last real center / group into the padding lanes so the
        // SIMD tail contributes valid (in-range) depths and group lookups.
        if (num_gaussians > 0) {
            const float lx = centers_x[num_gaussians - 1];
            const float ly = centers_y[num_gaussians - 1];
            const float lz = centers_z[num_gaussians - 1];
            const uint32_t lg = group_indices[num_gaussians - 1];
            for (int32_t i = num_gaussians; i < padded_count; i++) {
                centers_x[i] = lx;
                centers_y[i] = ly;
                centers_z[i] = lz;
                group_indices[i] = lg;
            }
        }
    }

    // Run sorting using the newest view projection matrix. Mutates internal
    // buffers.
    emscripten::val sort(const emscripten::val &Tz_cam_groups_val) {
        const auto Tz_cam_groups_buffer =
            emscripten::convertJSArrayToNumberVector<float>(Tz_cam_groups_val);
        const int32_t num_groups = Tz_cam_groups_buffer.size() / 4;
        const int32_t n_vec = padded_count / 4;

        // We do a 16-bit counting sort. This is mostly translated from Kevin
        // Kwok's Javascript implementation:
        //     https://github.com/antimatter15/splat/blob/main/main.js
        //
        // Note: we want to sort from minimum Z (high depth) to maximum Z (low
        // depth). gaussian_zs holds the per-Gaussian camera-space z as floats
        // (one f32x4 per group of 4 Gaussians).
        std::vector<v128_t> gaussian_zs(n_vec);

        const float *cx = centers_x.data();
        const float *cy = centers_y.data();
        const float *cz = centers_z.data();

        v128_t vmin = wasm_f32x4_splat(std::numeric_limits<float>::infinity());
        v128_t vmax = wasm_f32x4_splat(-std::numeric_limits<float>::infinity());

        // --- Pass 1: compute camera-space z for every Gaussian. ---
        // The depth of a Gaussian is the dot product of its homogeneous center
        // with row 2 (the z row) of its group's world->camera transform:
        //     cam_z = r0*x + r1*y + r2*z + r3
        if (num_groups == 1) {
            // Fast path: a single group means constant coefficients, so we can
            // splat them once and run a pure-vertical SIMD loop (no per-lane
            // gather, no horizontal reductions).
            const v128_t r0 = wasm_f32x4_splat(Tz_cam_groups_buffer[0]);
            const v128_t r1 = wasm_f32x4_splat(Tz_cam_groups_buffer[1]);
            const v128_t r2 = wasm_f32x4_splat(Tz_cam_groups_buffer[2]);
            const v128_t r3 = wasm_f32x4_splat(Tz_cam_groups_buffer[3]);
            for (int32_t i = 0; i < n_vec; i++) {
                const v128_t x = wasm_v128_load(cx + i * 4);
                const v128_t y = wasm_v128_load(cy + i * 4);
                const v128_t z = wasm_v128_load(cz + i * 4);
                v128_t camz = wasm_f32x4_add(r3, wasm_f32x4_mul(r0, x));
                camz = wasm_f32x4_add(camz, wasm_f32x4_mul(r1, y));
                camz = wasm_f32x4_add(camz, wasm_f32x4_mul(r2, z));
                gaussian_zs[i] = camz;
                vmin = wasm_f32x4_pmin(vmin, camz);
                vmax = wasm_f32x4_pmax(vmax, camz);
            }
        } else {
            // General path: gather each lane's group coefficients. Still
            // vertical multiply/add, just with per-lane coefficient vectors.
            const float *Tz = Tz_cam_groups_buffer.data();
            const uint32_t *gi = group_indices.data();
            for (int32_t i = 0; i < n_vec; i++) {
                const int32_t b = i * 4;
                const uint32_t i0 = gi[b + 0];
                const uint32_t i1 = gi[b + 1];
                const uint32_t i2 = gi[b + 2];
                const uint32_t i3 = gi[b + 3];
                v128_t r0, r1, r2, r3;
                if (i0 == i1 && i0 == i2 && i0 == i3) {
                    // Common case: groups are contiguous blocks (see
                    // mergeGaussianGroups), so all 4 lanes share a group except
                    // at the handful of block boundaries. Splat once -- no
                    // gather.
                    const float *row = &Tz[i0 * 4];
                    r0 = wasm_f32x4_splat(row[0]);
                    r1 = wasm_f32x4_splat(row[1]);
                    r2 = wasm_f32x4_splat(row[2]);
                    r3 = wasm_f32x4_splat(row[3]);
                } else {
                    // Straddling a group boundary: gather per lane.
                    const uint32_t g0 = i0 * 4;
                    const uint32_t g1 = i1 * 4;
                    const uint32_t g2 = i2 * 4;
                    const uint32_t g3 = i3 * 4;
                    r0 = wasm_f32x4_make(Tz[g0], Tz[g1], Tz[g2], Tz[g3]);
                    r1 = wasm_f32x4_make(
                        Tz[g0 + 1], Tz[g1 + 1], Tz[g2 + 1], Tz[g3 + 1]
                    );
                    r2 = wasm_f32x4_make(
                        Tz[g0 + 2], Tz[g1 + 2], Tz[g2 + 2], Tz[g3 + 2]
                    );
                    r3 = wasm_f32x4_make(
                        Tz[g0 + 3], Tz[g1 + 3], Tz[g2 + 3], Tz[g3 + 3]
                    );
                }
                const v128_t x = wasm_v128_load(cx + b);
                const v128_t y = wasm_v128_load(cy + b);
                const v128_t z = wasm_v128_load(cz + b);
                v128_t camz = wasm_f32x4_add(r3, wasm_f32x4_mul(r0, x));
                camz = wasm_f32x4_add(camz, wasm_f32x4_mul(r1, y));
                camz = wasm_f32x4_add(camz, wasm_f32x4_mul(r2, z));
                gaussian_zs[i] = camz;
                vmin = wasm_f32x4_pmin(vmin, camz);
                vmax = wasm_f32x4_pmax(vmax, camz);
            }
        }

        if (num_gaussians == 0) {
            return emscripten::val(emscripten::typed_memory_view(
                sorted_indices.size(),
                sorted_indices.empty() ? nullptr : &sorted_indices[0]
            ));
        }

        const float min_z = hmin_f32x4(vmin);
        const float max_z = hmax_f32x4(vmax);

        // --- Pass 2: quantize depths into 16-bit bins and build a histogram.
        // Map [min_z, max_z] -> [0, 65535]. We bin in float directly (no
        // intermediate integer round-trip) and accumulate the histogram in the
        // same sweep, so the bins are never re-read from memory just to count
        // them. (A two-pass 8-bit LSD radix was also tried to make the later
        // scatter more cache-local, but it was slower: the index array fits in
        // modern L2, so the extra passes' memory traffic didn't pay off.)
        const float inv = (256.0f * 256.0f - 1.0f) / (max_z - min_z + 1e-5f);
        const v128_t vmin_s = wasm_f32x4_splat(min_z);
        const v128_t vinv = wasm_f32x4_splat(inv);
        // gaussian_zs is reinterpreted in place from float depths to int bins.
        int32_t *bins = reinterpret_cast<int32_t *>(gaussian_zs.data());
        std::array<int32_t, 256 * 256> counts0({0});
        // Whole vectors whose 4 lanes are all real Gaussians.
        const int32_t full_vec = num_gaussians / 4;
        for (int32_t i = 0; i < full_vec; i++) {
            const v128_t z_bin = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_mul(
                wasm_f32x4_sub(gaussian_zs[i], vmin_s), vinv
            ));
            wasm_v128_store(&bins[i * 4], z_bin);
            counts0[wasm_i32x4_extract_lane(z_bin, 0)]++;
            counts0[wasm_i32x4_extract_lane(z_bin, 1)]++;
            counts0[wasm_i32x4_extract_lane(z_bin, 2)]++;
            counts0[wasm_i32x4_extract_lane(z_bin, 3)]++;
        }
        // Tail: the final partial vector (if any). Store its bins, then count
        // only the lanes that correspond to real Gaussians.
        for (int32_t i = full_vec; i < n_vec; i++) {
            const v128_t z_bin = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_mul(
                wasm_f32x4_sub(gaussian_zs[i], vmin_s), vinv
            ));
            wasm_v128_store(&bins[i * 4], z_bin);
        }
        for (int32_t i = full_vec * 4; i < num_gaussians; i++) {
            counts0[bins[i]]++;
        }
        // Exclusive prefix sum in place: counts0 becomes the per-bin write
        // cursor. Reusing the histogram array avoids a second 256KB scratch
        // buffer (and its zero-init), which is pure per-sort overhead.
        int32_t running = 0;
        for (int32_t i = 0; i < 256 * 256; i++) {
            const int32_t c = counts0[i];
            counts0[i] = running;
            running += c;
        }

        // Update and return sorted indices.
        for (int32_t i = 0; i < num_gaussians; i++)
            sorted_indices[counts0[bins[i]]++] = i;
        return emscripten::val(emscripten::typed_memory_view(
            sorted_indices.size(), &(sorted_indices[0])
        ));
    }
};

EMSCRIPTEN_BINDINGS(c) {
    emscripten::class_<Sorter>("Sorter")
        .constructor<emscripten::val, emscripten::val>()
        .function("setBuffer", &Sorter::setBuffer)
        .function("sort", &Sorter::sort, emscripten::allow_raw_pointers());
};
