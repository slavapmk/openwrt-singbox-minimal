Based on sing-box 1.14.4: https://github.com/SagerNet/sing-box/tree/v1.14.4

The minimal Go entry point registers selected upstream components instead of importing the default registry. Upstream source is downloaded at build time and is not vendored here. See LICENSE for the upstream GPL-3.0-or-later notice.

This repository also contains the LuCI view, OpenWrt service/controller, installer and build/packaging scripts used with that minimal core.
