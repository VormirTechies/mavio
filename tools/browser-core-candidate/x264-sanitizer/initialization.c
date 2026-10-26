#include <stdint.h>
#include <stdio.h>
#include "x264.h"

int main(void)
{
    for (int valid = 0; valid <= 1; valid++)
    {
        x264_param_t param;
        x264_param_default(&param);
        param.i_width = valid ? 16 : 0;
        param.i_height = 16;
        param.i_csp = X264_CSP_I420;
        param.i_bitdepth = 8;
        param.i_threads = 1;

        x264_t *encoder = x264_encoder_open(&param);
        int matched = valid ? encoder != NULL : encoder == NULL;
        if (encoder)
            x264_encoder_close(encoder);
        x264_param_cleanup(&param);

        if (!matched)
        {
            fprintf(stderr, "UNEXPECTED_INITIALIZATION_RESULT\n");
            return 2;
        }
        fprintf(stderr, "%s\n", valid ?
            "VALID_INITIALIZATION_CLEANUP_PASSED" :
            "EXPECTED_INITIALIZATION_FAILURE");
    }
    return 0;
}
