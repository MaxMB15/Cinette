// MPV bridge for iOS using MPVKit (prebuilt libmpv xcframeworks).
// Rendering path: CAMetalLayer passed to mpv via --wid; mpv drives the layer
// itself using vo=gpu-next + gpu-api=vulkan + gpu-context=moltenvk.
// No mpv_render_context / no CADisplayLink — mpv owns the display loop.
//
// C entry point: ios_play_mpv_url(const char *url) — called from Rust.

#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#import <AVFoundation/AVFoundation.h>
#import <AVKit/AVKit.h>
#import <MediaPlayer/MediaPlayer.h>

@import Libmpv;

#pragma mark - Metal-backed view ------------------------------------------------

@interface MpvMetalView : UIView
@end

@implementation MpvMetalView
+ (Class)layerClass { return [CAMetalLayer class]; }
- (instancetype)initWithFrame:(CGRect)frame {
    self = [super initWithFrame:frame];
    if (!self) return nil;
    self.contentScaleFactor = UIScreen.mainScreen.nativeScale;
    CAMetalLayer *ml = (CAMetalLayer *)self.layer;
    ml.framebufferOnly = YES;
    ml.backgroundColor = UIColor.blackColor.CGColor;
    return self;
}
@end

#pragma mark - MPV bridge -------------------------------------------------------

@interface MpvBridge : NSObject
@property (nonatomic) mpv_handle *mpv;
@property (nonatomic, strong) MpvMetalView *metalView;
@property (nonatomic, strong) UIViewController *modal;
@property (nonatomic, strong) UILabel *statusLabel;
@property (nonatomic, strong) dispatch_queue_t eventQueue;

// Controls
@property (nonatomic, strong) UIVisualEffectView *controlsBar;
@property (nonatomic, strong) UIButton *playPauseBtn;
@property (nonatomic, strong) UISlider *seekSlider;
@property (nonatomic, strong) UILabel *timeLabel;
@property (nonatomic, strong) UILabel *durationLabel;
@property (nonatomic, strong) AVRoutePickerView *routePicker;
@property (nonatomic, strong) NSTimer *controlsHideTimer;
@property (nonatomic) BOOL scrubbing;
@property (nonatomic) double lastTimePos;
@property (nonatomic) double lastDuration;
@property (nonatomic) BOOL paused;
@property (nonatomic, copy) NSString *lastURL;
@end

@implementation MpvBridge

+ (instancetype)shared {
    static MpvBridge *s = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ s = [MpvBridge new]; });
    return s;
}

- (void)logStatus:(NSString *)line {
    NSLog(@"[mpv] %@", line);
    dispatch_async(dispatch_get_main_queue(), ^{
        NSString *existing = self.statusLabel.text ?: @"";
        NSArray *lines = [existing componentsSeparatedByString:@"\n"];
        if (lines.count > 20) {
            lines = [lines subarrayWithRange:NSMakeRange(lines.count - 20, 20)];
            existing = [lines componentsJoinedByString:@"\n"];
        }
        self.statusLabel.text = [existing stringByAppendingFormat:@"\n%@", line];
    });
}

- (void)playURL:(NSString *)url {
    dispatch_async(dispatch_get_main_queue(), ^{ [self setupAndPlay:url]; });
}

- (UIViewController *)topVC {
    UIWindow *win = nil;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        UIWindowScene *ws = (UIWindowScene *)scene;
        for (UIWindow *w in ws.windows) { if (w.isKeyWindow) { win = w; break; } }
        if (!win && ws.windows.count > 0) win = ws.windows.firstObject;
        if (win) break;
    }
    UIViewController *vc = win.rootViewController;
    while (vc.presentedViewController) vc = vc.presentedViewController;
    return vc;
}

- (void)setupAndPlay:(NSString *)url {
    self.lastURL = url;
    NSError *audioErr = nil;
    [[AVAudioSession sharedInstance] setCategory:AVAudioSessionCategoryPlayback
                                            mode:AVAudioSessionModeMoviePlayback
                                         options:0
                                           error:&audioErr];
    [[AVAudioSession sharedInstance] setActive:YES error:nil];

    UIViewController *rootVC = [self topVC];
    if (!rootVC) { NSLog(@"[mpv] no root VC"); return; }

    UIViewController *vc = [UIViewController new];
    vc.view.backgroundColor = UIColor.blackColor;
    vc.modalPresentationStyle = UIModalPresentationFullScreen;
    self.modal = vc;

    MpvMetalView *mv = [MpvMetalView new];
    mv.translatesAutoresizingMaskIntoConstraints = NO;
    [vc.view addSubview:mv];
    self.metalView = mv;

    // Tap toggles controls; double-tap seeks
    UITapGestureRecognizer *single = [[UITapGestureRecognizer alloc]
        initWithTarget:self action:@selector(toggleControls)];
    UITapGestureRecognizer *doubleT = [[UITapGestureRecognizer alloc]
        initWithTarget:self action:@selector(doubleTapSeek:)];
    doubleT.numberOfTapsRequired = 2;
    [single requireGestureRecognizerToFail:doubleT];
    [mv addGestureRecognizer:doubleT];
    [mv addGestureRecognizer:single];

    UIButton *close = [UIButton buttonWithType:UIButtonTypeClose];
    close.translatesAutoresizingMaskIntoConstraints = NO;
    [close addTarget:self action:@selector(stop) forControlEvents:UIControlEventTouchUpInside];
    [vc.view addSubview:close];

    UILabel *status = [UILabel new];
    status.translatesAutoresizingMaskIntoConstraints = NO;
    status.numberOfLines = 0;
    status.textColor = UIColor.greenColor;
    status.font = [UIFont fontWithName:@"Menlo" size:10];
    status.backgroundColor = [UIColor colorWithWhite:0 alpha:0.5];
    status.text = @"starting... (tap to copy)";
    status.userInteractionEnabled = YES;
    [status addGestureRecognizer:[[UITapGestureRecognizer alloc]
                                   initWithTarget:self action:@selector(copyLogs:)]];
    [vc.view addSubview:status];
    self.statusLabel = status;

    [self buildControlsBar:vc.view];

    UILayoutGuide *safe = vc.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [mv.topAnchor constraintEqualToAnchor:vc.view.topAnchor],
        [mv.bottomAnchor constraintEqualToAnchor:vc.view.bottomAnchor],
        [mv.leadingAnchor constraintEqualToAnchor:vc.view.leadingAnchor],
        [mv.trailingAnchor constraintEqualToAnchor:vc.view.trailingAnchor],

        [close.topAnchor constraintEqualToAnchor:safe.topAnchor constant:8],
        [close.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:16],
        [close.widthAnchor constraintEqualToConstant:40],
        [close.heightAnchor constraintEqualToConstant:40],

        [status.topAnchor constraintEqualToAnchor:close.bottomAnchor constant:8],
        [status.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:16],
        [status.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-16],
        [status.heightAnchor constraintLessThanOrEqualToConstant:220],
    ]];

    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(appBackground)
                                                 name:UIApplicationDidEnterBackgroundNotification object:nil];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(appForeground)
                                                 name:UIApplicationWillEnterForegroundNotification object:nil];

    [rootVC presentViewController:vc animated:YES completion:^{
        [self startMpv:url];
        [self scheduleControlsHide];
    }];
}

- (void)buildControlsBar:(UIView *)parent {
    UIVisualEffectView *bar = [[UIVisualEffectView alloc]
        initWithEffect:[UIBlurEffect effectWithStyle:UIBlurEffectStyleSystemThinMaterialDark]];
    bar.translatesAutoresizingMaskIntoConstraints = NO;
    bar.layer.cornerRadius = 12;
    bar.clipsToBounds = YES;
    [parent addSubview:bar];
    self.controlsBar = bar;

    UIButton *pp = [UIButton buttonWithType:UIButtonTypeSystem];
    pp.translatesAutoresizingMaskIntoConstraints = NO;
    [pp setImage:[UIImage systemImageNamed:@"pause.fill"] forState:UIControlStateNormal];
    pp.tintColor = UIColor.whiteColor;
    [pp addTarget:self action:@selector(togglePause) forControlEvents:UIControlEventTouchUpInside];
    [bar.contentView addSubview:pp];
    self.playPauseBtn = pp;

    UILabel *cur = [UILabel new];
    cur.translatesAutoresizingMaskIntoConstraints = NO;
    cur.text = @"--:--";
    cur.textColor = UIColor.whiteColor;
    cur.font = [UIFont monospacedDigitSystemFontOfSize:12 weight:UIFontWeightRegular];
    [bar.contentView addSubview:cur];
    self.timeLabel = cur;

    UISlider *slider = [UISlider new];
    slider.translatesAutoresizingMaskIntoConstraints = NO;
    slider.minimumValue = 0;
    slider.maximumValue = 1;
    [slider addTarget:self action:@selector(seekScrub:) forControlEvents:UIControlEventValueChanged];
    [slider addTarget:self action:@selector(seekBegin:) forControlEvents:UIControlEventTouchDown];
    [slider addTarget:self action:@selector(seekEnd:)
      forControlEvents:UIControlEventTouchUpInside | UIControlEventTouchUpOutside | UIControlEventTouchCancel];
    [bar.contentView addSubview:slider];
    self.seekSlider = slider;

    UILabel *dur = [UILabel new];
    dur.translatesAutoresizingMaskIntoConstraints = NO;
    dur.text = @"--:--";
    dur.textColor = UIColor.whiteColor;
    dur.font = [UIFont monospacedDigitSystemFontOfSize:12 weight:UIFontWeightRegular];
    [bar.contentView addSubview:dur];
    self.durationLabel = dur;

    AVRoutePickerView *route = [AVRoutePickerView new];
    route.translatesAutoresizingMaskIntoConstraints = NO;
    route.tintColor = UIColor.whiteColor;
    route.activeTintColor = UIColor.systemBlueColor;
    [bar.contentView addSubview:route];
    self.routePicker = route;

    UILayoutGuide *safe = parent.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [bar.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:16],
        [bar.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-16],
        [bar.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor constant:-16],
        [bar.heightAnchor constraintEqualToConstant:56],

        [pp.leadingAnchor constraintEqualToAnchor:bar.contentView.leadingAnchor constant:12],
        [pp.centerYAnchor constraintEqualToAnchor:bar.contentView.centerYAnchor],
        [pp.widthAnchor constraintEqualToConstant:40],
        [pp.heightAnchor constraintEqualToConstant:40],

        [cur.leadingAnchor constraintEqualToAnchor:pp.trailingAnchor constant:8],
        [cur.centerYAnchor constraintEqualToAnchor:bar.contentView.centerYAnchor],
        [cur.widthAnchor constraintGreaterThanOrEqualToConstant:44],

        [slider.leadingAnchor constraintEqualToAnchor:cur.trailingAnchor constant:8],
        [slider.trailingAnchor constraintEqualToAnchor:dur.leadingAnchor constant:-8],
        [slider.centerYAnchor constraintEqualToAnchor:bar.contentView.centerYAnchor],

        [dur.trailingAnchor constraintEqualToAnchor:route.leadingAnchor constant:-8],
        [dur.centerYAnchor constraintEqualToAnchor:bar.contentView.centerYAnchor],
        [dur.widthAnchor constraintGreaterThanOrEqualToConstant:44],

        [route.trailingAnchor constraintEqualToAnchor:bar.contentView.trailingAnchor constant:-8],
        [route.centerYAnchor constraintEqualToAnchor:bar.contentView.centerYAnchor],
        [route.widthAnchor constraintEqualToConstant:40],
        [route.heightAnchor constraintEqualToConstant:40],
    ]];
}

- (NSString *)formatTime:(double)s {
    if (isnan(s) || s < 0) return @"--:--";
    int total = (int)s;
    int h = total / 3600;
    int m = (total % 3600) / 60;
    int sec = total % 60;
    return h > 0 ? [NSString stringWithFormat:@"%d:%02d:%02d", h, m, sec]
                 : [NSString stringWithFormat:@"%d:%02d", m, sec];
}

- (void)toggleControls {
    BOOL show = self.controlsBar.alpha < 0.5;
    [UIView animateWithDuration:0.2 animations:^{ self.controlsBar.alpha = show ? 1.0 : 0.0; }];
    if (show) [self scheduleControlsHide];
}

- (void)scheduleControlsHide {
    [self.controlsHideTimer invalidate];
    self.controlsHideTimer = [NSTimer scheduledTimerWithTimeInterval:4.0 repeats:NO
        block:^(NSTimer * _Nonnull t) {
            if (self.scrubbing) return;
            [UIView animateWithDuration:0.3 animations:^{ self.controlsBar.alpha = 0.0; }];
        }];
}

- (void)togglePause {
    if (!self.mpv) return;
    const char *cmd[] = { "cycle", "pause", NULL };
    mpv_command_async(self.mpv, 0, cmd);
    [self scheduleControlsHide];
}

- (void)doubleTapSeek:(UITapGestureRecognizer *)g {
    if (!self.mpv) return;
    CGPoint p = [g locationInView:self.metalView];
    BOOL forward = p.x > self.metalView.bounds.size.width / 2;
    const char *delta = forward ? "10" : "-10";
    const char *cmd[] = { "seek", delta, "relative", NULL };
    mpv_command_async(self.mpv, 0, cmd);
    [self logStatus:forward ? @"⏭ +10s" : @"⏮ -10s"];
}

- (void)seekBegin:(UISlider *)s { self.scrubbing = YES; [self.controlsHideTimer invalidate]; }
- (void)seekScrub:(UISlider *)s {
    if (self.lastDuration <= 0) return;
    self.timeLabel.text = [self formatTime:s.value * self.lastDuration];
}
- (void)seekEnd:(UISlider *)s {
    self.scrubbing = NO;
    if (self.mpv && self.lastDuration > 0) {
        double target = s.value * self.lastDuration;
        char buf[64]; snprintf(buf, sizeof(buf), "%.3f", target);
        const char *cmd[] = { "seek", buf, "absolute", NULL };
        mpv_command_async(self.mpv, 0, cmd);
    }
    [self scheduleControlsHide];
}

- (void)startMpv:(NSString *)url {
    self.mpv = mpv_create();
    if (!self.mpv) { [self logStatus:@"mpv_create FAILED"]; return; }

    // Hand mpv the CAMetalLayer via --wid. mpv renders directly to it
    // through its internal gpu-next vo + MoltenVK backend.
    void *layerPtr = (__bridge void *)self.metalView.layer;
    int64_t wid = (int64_t)(uintptr_t)layerPtr;
    mpv_set_option(self.mpv, "wid", MPV_FORMAT_INT64, &wid);

    mpv_set_option_string(self.mpv, "vo", "gpu-next");
    mpv_set_option_string(self.mpv, "gpu-api", "vulkan");
    mpv_set_option_string(self.mpv, "gpu-context", "moltenvk");
    mpv_set_option_string(self.mpv, "hwdec", "videotoolbox");
    mpv_set_option_string(self.mpv, "hwdec-codecs", "all");
    mpv_set_option_string(self.mpv, "video-rotate", "no");
    mpv_set_option_string(self.mpv, "profile", "fast");
    mpv_set_option_string(self.mpv, "cache", "yes");
    mpv_set_option_string(self.mpv, "cache-secs", "10");
    mpv_set_option_string(self.mpv, "terminal", "no");
    mpv_set_option_string(self.mpv, "ytdl", "no");
    mpv_set_option_string(self.mpv, "msg-level", "all=v");

    int init = mpv_initialize(self.mpv);
    if (init < 0) {
        [self logStatus:[NSString stringWithFormat:@"mpv_initialize: %s", mpv_error_string(init)]];
        mpv_terminate_destroy(self.mpv);
        self.mpv = NULL;
        return;
    }
    [self logStatus:@"mpv_initialize OK (gpu-next/moltenvk)"];

    mpv_request_log_messages(self.mpv, "v");
    mpv_observe_property(self.mpv, 1, "time-pos", MPV_FORMAT_DOUBLE);
    mpv_observe_property(self.mpv, 2, "duration", MPV_FORMAT_DOUBLE);
    mpv_observe_property(self.mpv, 3, "pause", MPV_FORMAT_FLAG);
    mpv_observe_property(self.mpv, 4, "paused-for-cache", MPV_FORMAT_FLAG);

    // The event queue owns the handle's teardown: stop sends "quit", and this
    // block destroys the handle once mpv reports MPV_EVENT_SHUTDOWN, so
    // mpv_terminate_destroy never runs while mpv_wait_event is waiting.
    // mpv can also shut down without stop, so self.mpv is cleared first on the
    // main thread, where every other use of it runs. The destroy goes back to
    // the event queue so it can't block the main thread.
    // mpv draws into the view's layer until it's destroyed, so the view is
    // kept alive until then and released on the main thread.
    mpv_handle *mpv = self.mpv;
    __block MpvMetalView *view = self.metalView;
    dispatch_queue_t queue = dispatch_queue_create("mpv.events", DISPATCH_QUEUE_SERIAL);
    self.eventQueue = queue;
    dispatch_async(queue, ^{
        [self pumpEvents:mpv];
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.mpv == mpv) self.mpv = NULL;
            dispatch_async(queue, ^{
                mpv_terminate_destroy(mpv);
                dispatch_async(dispatch_get_main_queue(), ^{ view = nil; });
            });
        });
    });

    const char *urlC = [url UTF8String];
    const char *cmd[] = { "loadfile", urlC, NULL };
    int lf = mpv_command(self.mpv, cmd);
    [self logStatus:[NSString stringWithFormat:@"loadfile rc=%d", lf]];

    [self configureRemoteCommands];
}

- (void)configureRemoteCommands {
    MPRemoteCommandCenter *c = [MPRemoteCommandCenter sharedCommandCenter];
    [c.playCommand addTarget:self action:@selector(playCmd:)];
    [c.pauseCommand addTarget:self action:@selector(pauseCmd:)];
    [c.skipForwardCommand addTarget:self action:@selector(skipFwd:)];
    [c.skipBackwardCommand addTarget:self action:@selector(skipBwd:)];
    c.skipForwardCommand.preferredIntervals = @[@10];
    c.skipBackwardCommand.preferredIntervals = @[@10];
}

- (MPRemoteCommandHandlerStatus)playCmd:(MPRemoteCommandEvent *)e {
    if (!self.mpv) return MPRemoteCommandHandlerStatusCommandFailed;
    const char *cmd[] = { "set", "pause", "no", NULL };
    mpv_command_async(self.mpv, 0, cmd);
    return MPRemoteCommandHandlerStatusSuccess;
}
- (MPRemoteCommandHandlerStatus)pauseCmd:(MPRemoteCommandEvent *)e {
    if (!self.mpv) return MPRemoteCommandHandlerStatusCommandFailed;
    const char *cmd[] = { "set", "pause", "yes", NULL };
    mpv_command_async(self.mpv, 0, cmd);
    return MPRemoteCommandHandlerStatusSuccess;
}
- (MPRemoteCommandHandlerStatus)skipFwd:(MPRemoteCommandEvent *)e {
    if (!self.mpv) return MPRemoteCommandHandlerStatusCommandFailed;
    const char *cmd[] = { "seek", "10", "relative", NULL };
    mpv_command_async(self.mpv, 0, cmd);
    return MPRemoteCommandHandlerStatusSuccess;
}
- (MPRemoteCommandHandlerStatus)skipBwd:(MPRemoteCommandEvent *)e {
    if (!self.mpv) return MPRemoteCommandHandlerStatusCommandFailed;
    const char *cmd[] = { "seek", "-10", "relative", NULL };
    mpv_command_async(self.mpv, 0, cmd);
    return MPRemoteCommandHandlerStatusSuccess;
}

- (void)updateNowPlaying {
    NSMutableDictionary *info = [NSMutableDictionary dictionary];
    info[MPMediaItemPropertyTitle] = self.lastURL.lastPathComponent ?: @"Stream";
    if (self.lastDuration > 0) info[MPMediaItemPropertyPlaybackDuration] = @(self.lastDuration);
    info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(self.lastTimePos);
    info[MPNowPlayingInfoPropertyPlaybackRate] = @(self.paused ? 0.0 : 1.0);
    [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = info;
}

- (void)appBackground {
    if (!self.mpv) return;
    mpv_set_option_string(self.mpv, "vid", "no");
}
- (void)appForeground {
    if (!self.mpv) return;
    mpv_set_option_string(self.mpv, "vid", "auto");
}

- (void)copyLogs:(UITapGestureRecognizer *)g {
    UIPasteboard.generalPasteboard.string = self.statusLabel.text ?: @"";
    UIView *flash = [[UIView alloc] initWithFrame:self.statusLabel.bounds];
    flash.backgroundColor = [UIColor colorWithWhite:1 alpha:0.3];
    flash.userInteractionEnabled = NO;
    [self.statusLabel addSubview:flash];
    [UIView animateWithDuration:0.25 animations:^{ flash.alpha = 0; }
                     completion:^(BOOL _) { [flash removeFromSuperview]; }];
}

- (void)pumpEvents:(mpv_handle *)mpv {
    for (;;) {
        mpv_event *ev = mpv_wait_event(mpv, -1);
        if (!ev || ev->event_id == MPV_EVENT_NONE) continue;
        if (ev->event_id == MPV_EVENT_SHUTDOWN) break;
        if (ev->event_id == MPV_EVENT_LOG_MESSAGE) {
            mpv_event_log_message *m = ev->data;
            if (strcmp(m->level, "v") != 0 && strcmp(m->level, "debug") != 0 && strcmp(m->level, "trace") != 0) {
                NSString *s = [NSString stringWithFormat:@"[%s/%s] %s", m->level, m->prefix, m->text];
                s = [s stringByReplacingOccurrencesOfString:@"\n" withString:@""];
                [self logStatus:s];
            }
        } else if (ev->event_id == MPV_EVENT_FILE_LOADED) {
            [self logStatus:@"FILE_LOADED"];
        } else if (ev->event_id == MPV_EVENT_END_FILE) {
            mpv_event_end_file *ef = ev->data;
            [self logStatus:[NSString stringWithFormat:@"END_FILE reason=%d err=%s",
                             ef->reason, mpv_error_string(ef->error)]];
        } else if (ev->event_id == MPV_EVENT_PROPERTY_CHANGE) {
            mpv_event_property *p = ev->data;
            if (!p || !p->data) continue;
            if (strcmp(p->name, "time-pos") == 0 && p->format == MPV_FORMAT_DOUBLE) {
                double v = *(double *)p->data;
                self.lastTimePos = v;
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (!self.scrubbing) {
                        self.timeLabel.text = [self formatTime:v];
                        if (self.lastDuration > 0) self.seekSlider.value = (float)(v / self.lastDuration);
                    }
                    [self updateNowPlaying];
                });
            } else if (strcmp(p->name, "duration") == 0 && p->format == MPV_FORMAT_DOUBLE) {
                double v = *(double *)p->data;
                self.lastDuration = v;
                dispatch_async(dispatch_get_main_queue(), ^{
                    self.durationLabel.text = [self formatTime:v];
                    self.seekSlider.enabled = (v > 0);
                });
            } else if (strcmp(p->name, "pause") == 0 && p->format == MPV_FORMAT_FLAG) {
                BOOL paused = *(int *)p->data != 0;
                self.paused = paused;
                dispatch_async(dispatch_get_main_queue(), ^{
                    NSString *sym = paused ? @"play.fill" : @"pause.fill";
                    [self.playPauseBtn setImage:[UIImage systemImageNamed:sym]
                                       forState:UIControlStateNormal];
                    [self updateNowPlaying];
                });
            } else if (strcmp(p->name, "paused-for-cache") == 0 && p->format == MPV_FORMAT_FLAG) {
                BOOL buffering = *(int *)p->data != 0;
                if (buffering) [self logStatus:@"buffering…"];
            }
        }
    }
}

- (void)stop {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    MPRemoteCommandCenter *c = [MPRemoteCommandCenter sharedCommandCenter];
    [c.playCommand removeTarget:self];
    [c.pauseCommand removeTarget:self];
    [c.skipForwardCommand removeTarget:self];
    [c.skipBackwardCommand removeTarget:self];
    [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = nil;

    // Ask mpv to quit; the event queue destroys the handle after shutdown.
    mpv_handle *mpv = self.mpv;
    self.mpv = NULL;
    if (mpv) {
        const char *cmd[] = { "quit", NULL };
        mpv_command_async(mpv, 0, cmd);
    }
    [self.modal dismissViewControllerAnimated:YES completion:nil];
    self.modal = nil;
    self.metalView = nil;
}

@end

#pragma mark - C entry point (Rust FFI) -----------------------------------------

__attribute__((visibility("default")))
int ios_play_mpv_url(const char *url) {
    if (!url) return -1;
    NSString *u = [NSString stringWithUTF8String:url];
    [[MpvBridge shared] playURL:u];
    return 0;
}
